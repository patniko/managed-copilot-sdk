import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Depth-aware forward-motion blur + tone mapping + colour grade. Outputs display-referred (sRGB) colour. */
const GRADE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uFoe;
uniform float uBlur;
uniform float uBlurMax;
uniform float uAspect;
uniform mat4 uProjInv;
uniform float uReversed;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uVibrance;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uLift;
varying vec2 vUv;

float linDepth(float d) {
  float zn = uReversed > 0.5 ? d : d * 2.0 - 1.0;
  vec4 p = uProjInv * vec4(0.0, 0.0, zn, 1.0);
  return -p.z / p.w;
}
vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 c0 = texture2D(tScene, vUv);
  vec3 col = c0.rgb;
  if (uBlur > 0.0001) {
    float depth = linDepth(texture2D(tDepth, vUv).r);
    vec2 d = vUv - uFoe;
    float amt = min(uBlur / max(depth, 0.35), uBlurMax);
    // stronger toward the bottom/edges of the frame (ground streaks), like a fast handheld chase cam
    vec2 bv = d * amt * c0.a;
    float len = length(bv * vec2(uAspect, 1.0));
    if (len > 0.0015) {
      float jitter = hash12(gl_FragCoord.xy) - 0.5;
      vec3 acc = col;
      float wsum = 1.0;
      for (int i = 1; i <= 14; i++) {
        float t = (float(i) + jitter) / 14.0;
        vec4 s = texture2D(tScene, vUv - bv * t);
        float w = s.a * (1.0 - t * 0.35);
        acc += s.rgb * w;
        wsum += w;
      }
      col = acc / wsum;
    }
  }
  col *= uExposure;
  col = vec3(1.0) - exp(-col);
  col = toSRGB(col);
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  float chroma = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
  col = mix(vec3(l), col, uSaturation + uVibrance * (1.0 - chroma));
  col += uShadowTint * pow(1.0 - l, 2.0) + uHighlightTint * l * l;
  col = col * (1.0 - uLift) + uLift;
  // alpha carries the subject mask (0 = player) through to the paint pass
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), c0.a);
}
`;

const TENSOR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 d = uTexel;
  vec3 c00 = texture2D(tSrc, vUv + vec2(-d.x, -d.y)).rgb;
  vec3 c10 = texture2D(tSrc, vUv + vec2(0.0, -d.y)).rgb;
  vec3 c20 = texture2D(tSrc, vUv + vec2(d.x, -d.y)).rgb;
  vec3 c01 = texture2D(tSrc, vUv + vec2(-d.x, 0.0)).rgb;
  vec3 c21 = texture2D(tSrc, vUv + vec2(d.x, 0.0)).rgb;
  vec3 c02 = texture2D(tSrc, vUv + vec2(-d.x, d.y)).rgb;
  vec3 c12 = texture2D(tSrc, vUv + vec2(0.0, d.y)).rgb;
  vec3 c22 = texture2D(tSrc, vUv + vec2(d.x, d.y)).rgb;
  vec3 sx = (c20 + 2.0 * c21 + c22 - c00 - 2.0 * c01 - c02) * 0.25;
  vec3 sy = (c02 + 2.0 * c12 + c22 - c00 - 2.0 * c10 - c20) * 0.25;
  gl_FragColor = vec4(dot(sx, sx), dot(sy, sy), dot(sx, sy), 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(tSrc, vUv) * 0.2270270270;
  sum += texture2D(tSrc, vUv + uDir * 1.3846153846) * 0.3162162162;
  sum += texture2D(tSrc, vUv - uDir * 1.3846153846) * 0.3162162162;
  sum += texture2D(tSrc, vUv + uDir * 3.2307692308) * 0.0702702703;
  sum += texture2D(tSrc, vUv - uDir * 3.2307692308) * 0.0702702703;
  gl_FragColor = sum;
}
`;

/** Anisotropic Kuwahara filter with polynomial sector weights (Kyprianidis et al.). */
const KUWAHARA_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tTensor;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uSubjectRadius;
uniform float uQ;
uniform float uAlpha;
uniform float uHardness;
uniform float uZeroCross;
varying vec2 vUv;

void main() {
  // finer brush on the subject (the player has alpha 0 in the graded image)
  float radius = uRadius * mix(uSubjectRadius, 1.0, texture2D(tSrc, vUv).a);
  vec3 g = texture2D(tTensor, vUv).xyz;
  float E = g.x, F = g.z, Gg = g.y;
  float disc = sqrt(max((E - Gg) * (E - Gg) + 4.0 * F * F, 0.0));
  float l1 = 0.5 * (E + Gg + disc);
  float l2 = 0.5 * (E + Gg - disc);
  vec2 t = vec2(l1 - E, -F);
  t = length(t) > 1e-8 ? normalize(t) : vec2(0.0, 1.0);
  float phi = -atan(t.y, t.x);
  float A = (l1 + l2 > 1e-8) ? (l1 - l2) / (l1 + l2) : 0.0;

  float a = radius * clamp((uAlpha + A) / uAlpha, 0.1, 2.0);
  float b = radius * clamp(uAlpha / (uAlpha + A), 0.1, 2.0);
  float cp = cos(phi);
  float sp = sin(phi);
  mat2 R = mat2(cp, -sp, sp, cp);
  mat2 S = mat2(0.5 / a, 0.0, 0.0, 0.5 / b);
  mat2 SR = S * R;
  int maxX = int(sqrt(a * a * cp * cp + b * b * sp * sp));
  int maxY = int(sqrt(a * a * sp * sp + b * b * cp * cp));

  float zeta = 2.0 / radius;
  float sinZ = sin(uZeroCross);
  float eta = (zeta + cos(uZeroCross)) / (sinZ * sinZ);

  vec4 m0 = vec4(0.0), m1 = vec4(0.0), m2 = vec4(0.0), m3 = vec4(0.0), m4 = vec4(0.0), m5 = vec4(0.0), m6 = vec4(0.0), m7 = vec4(0.0);
  vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0), s4 = vec3(0.0), s5 = vec3(0.0), s6 = vec3(0.0), s7 = vec3(0.0);

  for (int y = -maxY; y <= maxY; ++y) {
    for (int x = -maxX; x <= maxX; ++x) {
      vec2 v = SR * vec2(float(x), float(y));
      if (dot(v, v) <= 0.25) {
        vec3 c = texture2D(tSrc, vUv + vec2(float(x), float(y)) * uTexel).rgb;
        vec3 cc = c * c;
        float vxx = zeta - eta * v.x * v.x;
        float vyy = zeta - eta * v.y * v.y;
        float z;
        z = max(0.0, v.y + vxx);  float w0 = z * z;
        z = max(0.0, -v.x + vyy); float w2 = z * z;
        z = max(0.0, -v.y + vxx); float w4 = z * z;
        z = max(0.0, v.x + vyy);  float w6 = z * z;
        vec2 r = 0.70710678 * vec2(v.x - v.y, v.x + v.y);
        vxx = zeta - eta * r.x * r.x;
        vyy = zeta - eta * r.y * r.y;
        z = max(0.0, r.y + vxx);  float w1 = z * z;
        z = max(0.0, -r.x + vyy); float w3 = z * z;
        z = max(0.0, -r.y + vxx); float w5 = z * z;
        z = max(0.0, r.x + vyy);  float w7 = z * z;
        float sum = w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7;
        float gw = exp(-3.125 * dot(v, v)) / max(sum, 1e-6);
        w0 *= gw; w1 *= gw; w2 *= gw; w3 *= gw; w4 *= gw; w5 *= gw; w6 *= gw; w7 *= gw;
        m0 += vec4(c * w0, w0); s0 += cc * w0;
        m1 += vec4(c * w1, w1); s1 += cc * w1;
        m2 += vec4(c * w2, w2); s2 += cc * w2;
        m3 += vec4(c * w3, w3); s3 += cc * w3;
        m4 += vec4(c * w4, w4); s4 += cc * w4;
        m5 += vec4(c * w5, w5); s5 += cc * w5;
        m6 += vec4(c * w6, w6); s6 += cc * w6;
        m7 += vec4(c * w7, w7); s7 += cc * w7;
      }
    }
  }

  vec4 o = vec4(0.0);
  #define RESOLVE(M, S) { \
    float ww = max(M.w, 1e-6); \
    vec3 mean = M.rgb / ww; \
    vec3 var = abs(S / ww - mean * mean); \
    float sigma2 = var.r + var.g + var.b; \
    float wk = 1.0 / (1.0 + pow(uHardness * 1000.0 * sigma2, 0.5 * uQ)); \
    o += vec4(mean * wk, wk); }
  RESOLVE(m0, s0) RESOLVE(m1, s1) RESOLVE(m2, s2) RESOLVE(m3, s3)
  RESOLVE(m4, s4) RESOLVE(m5, s5) RESOLVE(m6, s6) RESOLVE(m7, s7)
  gl_FragColor = vec4(o.w > 0.0 ? o.rgb / o.w : texture2D(tSrc, vUv).rgb, 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uExposure;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25 * uExposure;
  float l = max(c.r, max(c.g, c.b));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tPaint;
uniform sampler2D tBloom;
uniform vec2 uTexel;
uniform float uBloom;
uniform float uVignette;
uniform float uGrain;
uniform float uSharpen;
uniform float uTime;
uniform float uFade;
uniform vec3 uFadeColor;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec3 c = texture2D(tPaint, vUv).rgb;
  vec3 n = texture2D(tPaint, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tPaint, vUv - vec2(uTexel.x, 0.0)).rgb
         + texture2D(tPaint, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tPaint, vUv - vec2(0.0, uTexel.y)).rgb;
  c = clamp(c + (c - n * 0.25) * uSharpen, 0.0, 1.0);
  vec3 b = texture2D(tBloom, vUv).rgb * uBloom;
  b = b / (1.0 + b);
  c = 1.0 - (1.0 - c) * (1.0 - b);
  // canvas weave + paper fibres
  vec2 fc = gl_FragCoord.xy;
  float weave = (sin(fc.x * 1.7) * sin(fc.y * 1.7)) * 0.5;
  float fib = vnoise(fc * vec2(0.08, 0.6)) + vnoise(fc * vec2(0.6, 0.08)) - 1.0;
  c += (weave * 0.35 + fib * 0.65) * uGrain;
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * uVignette;
  c = mix(c, uFadeColor, uFade);
  c += (hash12(fc + fract(uTime) * 61.0) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}
`;

export interface PostSettings {
  painterly: boolean;
  renderScale: number;
  radius: number;
  /** Brush radius multiplier on the player (keeps the rider's detail, like the video's sharper subject). */
  subjectRadius: number;
  sharpness: number;
  hardness: number;
  anisotropy: number;
  zeroCross: number;
  exposure: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  shadowTint: THREE.Color;
  highlightTint: THREE.Color;
  lift: number;
  bloom: number;
  bloomThreshold: number;
  vignette: number;
  grain: number;
  sharpen: number;
  motionBlur: number;
}

export function defaultPostSettings(): PostSettings {
  return {
    painterly: true,
    renderScale: 1,
    radius: 5,
    subjectRadius: 0.55,
    sharpness: 8,
    hardness: 8,
    anisotropy: 1,
    zeroCross: 0.58,
    exposure: 1.0,
    contrast: 0.25,
    saturation: 1.3,
    vibrance: 0.25,
    shadowTint: new THREE.Color(0.02, 0.0, 0.06),
    highlightTint: new THREE.Color(0.03, 0.02, -0.02),
    lift: 0.01,
    bloom: 0.55,
    bloomThreshold: 0.9,
    vignette: 0.55,
    grain: 0.018,
    sharpen: 0.35,
    motionBlur: 1,
  };
}

function makeRT(w: number, h: number, type: THREE.TextureDataType, depth = false) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: depth,
    stencilBuffer: false,
  });
  if (depth) {
    rt.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
  }
  rt.texture.generateMipmaps = false;
  return rt;
}

function pass(frag: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

export interface FrameMotion {
  /** Speed of the camera along its view direction (m/s). */
  forwardSpeed: number;
  /** Focus of expansion in UV (where motion streams out from). */
  foe: THREE.Vector2;
}

/** Real-time "oil painting" post-processing chain. */
export class PainterlyPipeline {
  readonly settings = defaultPostSettings();
  private rtScene!: THREE.WebGLRenderTarget;
  private rtGrade!: THREE.WebGLRenderTarget;
  private rtTensorA!: THREE.WebGLRenderTarget;
  private rtTensorB!: THREE.WebGLRenderTarget;
  private rtPaint!: THREE.WebGLRenderTarget;
  private rtBright!: THREE.WebGLRenderTarget;
  private rtBloomA!: THREE.WebGLRenderTarget;
  private rtBloomB!: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private qScene = new THREE.Scene();
  private qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private width = 1;
  private height = 1;
  private rw = 1;
  private rh = 1;
  fade = 0;
  fadeColor = new THREE.Color(0, 0, 0);

  private mGrade = pass(GRADE_FRAG, {
    tScene: { value: null },
    tDepth: { value: null },
    uFoe: { value: new THREE.Vector2(0.5, 0.5) },
    uBlur: { value: 0 },
    uBlurMax: { value: 0.24 },
    uAspect: { value: 1 },
    uProjInv: { value: new THREE.Matrix4() },
    uReversed: { value: 0 },
    uExposure: { value: 1 },
    uContrast: { value: 0.2 },
    uSaturation: { value: 1.2 },
    uVibrance: { value: 0.2 },
    uShadowTint: { value: new THREE.Color() },
    uHighlightTint: { value: new THREE.Color() },
    uLift: { value: 0 },
  });
  private mTensor = pass(TENSOR_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  private mBlur = pass(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  private mKuwa = pass(KUWAHARA_FRAG, {
    tSrc: { value: null },
    tTensor: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uRadius: { value: 5 },
    uSubjectRadius: { value: 0.55 },
    uQ: { value: 8 },
    uAlpha: { value: 1 },
    uHardness: { value: 8 },
    uZeroCross: { value: 0.58 },
  });
  private mBright = pass(BRIGHT_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 1 },
    uExposure: { value: 1 },
  });
  private mFinal = pass(FINAL_FRAG, {
    tPaint: { value: null },
    tBloom: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uBloom: { value: 0.5 },
    uVignette: { value: 0.5 },
    uGrain: { value: 0.02 },
    uSharpen: { value: 0.3 },
    uTime: { value: 0 },
    uFade: { value: 0 },
    uFadeColor: { value: new THREE.Color() },
  });

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mFinal);
    this.quad.frustumCulled = false;
    this.qScene.add(this.quad);
    this.allocate(2, 2);
  }

  private allocate(w: number, h: number) {
    [this.rtScene, this.rtGrade, this.rtTensorA, this.rtTensorB, this.rtPaint, this.rtBright, this.rtBloomA, this.rtBloomB]
      .filter(Boolean)
      .forEach((rt) => {
        rt.depthTexture?.dispose();
        rt.dispose();
      });
    const s = this.settings.renderScale;
    const rw = Math.max(2, Math.round(w * s));
    const rh = Math.max(2, Math.round(h * s));
    this.rw = rw;
    this.rh = rh;
    this.rtScene = makeRT(rw, rh, THREE.HalfFloatType, true);
    this.rtGrade = makeRT(rw, rh, THREE.UnsignedByteType);
    this.rtTensorA = makeRT(rw, rh, THREE.HalfFloatType);
    this.rtTensorB = makeRT(rw, rh, THREE.HalfFloatType);
    this.rtPaint = makeRT(rw, rh, THREE.UnsignedByteType);
    const bw = Math.max(2, Math.round(rw / 2));
    const bh = Math.max(2, Math.round(rh / 2));
    this.rtBright = makeRT(bw, bh, THREE.HalfFloatType);
    this.rtBloomA = makeRT(Math.max(2, bw >> 1), Math.max(2, bh >> 1), THREE.HalfFloatType);
    this.rtBloomB = makeRT(Math.max(2, bw >> 1), Math.max(2, bh >> 1), THREE.HalfFloatType);
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.allocate(w, h);
  }

  setRenderScale(s: number) {
    if (Math.abs(s - this.settings.renderScale) < 0.01) return;
    this.settings.renderScale = s;
    this.allocate(this.width, this.height);
  }

  get renderSize() {
    return { w: this.rw, h: this.rh };
  }

  private draw(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.qScene, this.qCam);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number, motion?: FrameMotion) {
    const r = this.renderer;
    const st = this.settings;
    r.setRenderTarget(this.rtScene);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);

    // 1. motion blur + grade
    const g = this.mGrade.uniforms;
    g.tScene.value = this.rtScene.texture;
    g.tDepth.value = this.rtScene.depthTexture;
    g.uProjInv.value.copy(camera.projectionMatrixInverse);
    g.uReversed.value = r.capabilities.reversedDepthBuffer && (camera as unknown as { reversedDepth?: boolean }).reversedDepth ? 1 : 0;
    g.uAspect.value = this.rw / this.rh;
    const blur = motion && st.motionBlur > 0 ? Math.max(0, motion.forwardSpeed) * 0.022 * st.motionBlur : 0;
    g.uBlur.value = blur;
    if (motion) g.uFoe.value.copy(motion.foe);
    g.uExposure.value = st.exposure;
    g.uContrast.value = st.contrast;
    g.uSaturation.value = st.saturation;
    g.uVibrance.value = st.vibrance;
    g.uShadowTint.value.copy(st.shadowTint);
    g.uHighlightTint.value.copy(st.highlightTint);
    g.uLift.value = st.lift;
    this.draw(this.mGrade, this.rtGrade);

    let paintTex = this.rtGrade.texture;
    if (st.painterly) {
      // 2. structure tensor
      this.mTensor.uniforms.tSrc.value = this.rtGrade.texture;
      this.mTensor.uniforms.uTexel.value.set(1 / this.rw, 1 / this.rh);
      this.draw(this.mTensor, this.rtTensorA);
      // 3. smooth tensor
      this.mBlur.uniforms.tSrc.value = this.rtTensorA.texture;
      this.mBlur.uniforms.uDir.value.set(1.2 / this.rw, 0);
      this.draw(this.mBlur, this.rtTensorB);
      this.mBlur.uniforms.tSrc.value = this.rtTensorB.texture;
      this.mBlur.uniforms.uDir.value.set(0, 1.2 / this.rh);
      this.draw(this.mBlur, this.rtTensorA);
      // 4. anisotropic kuwahara
      const k = this.mKuwa.uniforms;
      k.tSrc.value = this.rtGrade.texture;
      k.tTensor.value = this.rtTensorA.texture;
      k.uTexel.value.set(1 / this.rw, 1 / this.rh);
      k.uRadius.value = Math.max(1.5, st.radius * (this.rh / 1080));
      k.uSubjectRadius.value = st.subjectRadius;
      k.uQ.value = st.sharpness;
      k.uAlpha.value = st.anisotropy;
      k.uHardness.value = st.hardness;
      k.uZeroCross.value = st.zeroCross;
      this.draw(this.mKuwa, this.rtPaint);
      paintTex = this.rtPaint.texture;
    }

    // 5. bloom
    if (st.bloom > 0) {
      const b = this.mBright.uniforms;
      b.tSrc.value = this.rtScene.texture;
      b.uTexel.value.set(1 / this.rw, 1 / this.rh);
      b.uThreshold.value = st.bloomThreshold;
      b.uExposure.value = st.exposure;
      this.draw(this.mBright, this.rtBright);
      const bw = this.rtBloomA.width;
      const bh = this.rtBloomA.height;
      this.mBlur.uniforms.tSrc.value = this.rtBright.texture;
      this.mBlur.uniforms.uDir.value.set(1.5 / bw, 0);
      this.draw(this.mBlur, this.rtBloomA);
      this.mBlur.uniforms.tSrc.value = this.rtBloomA.texture;
      this.mBlur.uniforms.uDir.value.set(0, 1.5 / bh);
      this.draw(this.mBlur, this.rtBloomB);
      this.mBlur.uniforms.tSrc.value = this.rtBloomB.texture;
      this.mBlur.uniforms.uDir.value.set(3 / bw, 0);
      this.draw(this.mBlur, this.rtBloomA);
      this.mBlur.uniforms.tSrc.value = this.rtBloomA.texture;
      this.mBlur.uniforms.uDir.value.set(0, 3 / bh);
      this.draw(this.mBlur, this.rtBloomB);
    }

    // 6. final composite to screen
    const f = this.mFinal.uniforms;
    f.tPaint.value = paintTex;
    f.tBloom.value = this.rtBloomB.texture;
    f.uTexel.value.set(1 / this.rw, 1 / this.rh);
    f.uBloom.value = st.bloom;
    f.uVignette.value = st.vignette;
    f.uGrain.value = st.grain;
    f.uSharpen.value = st.sharpen;
    f.uTime.value = time;
    f.uFade.value = this.fade;
    f.uFadeColor.value.copy(this.fadeColor);
    this.draw(this.mFinal, null);
  }
}
