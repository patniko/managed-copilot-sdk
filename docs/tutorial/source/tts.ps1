# Synthesizes each narration page with the built-in Windows voice Microsoft Mark (System.Speech, no cloud service):
# out\audio\<key>.wav, 24 kHz 16-bit mono. Run render.mjs first; it writes out\narration.json.
$ErrorActionPreference = "Stop"
$root = if ($env:TUTORIAL_OUT) { $env:TUTORIAL_OUT } else { Join-Path $PSScriptRoot "out" }
$items = Get-Content (Join-Path $root "narration.json") -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force (Join-Path $root "audio") | Out-Null
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($(if ($env:TUTORIAL_VOICE) { $env:TUTORIAL_VOICE } else { "Microsoft Mark" }))
$synth.Rate = -1
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($item in $items) {
  $synth.SetOutputToWaveFile((Join-Path $root "audio\$($item.key).wav"), $format)
  $synth.Speak($item.say)
  $synth.SetOutputToNull()
}
$synth.Dispose()
"synthesized $($items.Count) pages"
