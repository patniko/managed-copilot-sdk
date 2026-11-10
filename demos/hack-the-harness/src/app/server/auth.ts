import express, { type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SignJWT, jwtVerify } from "jose";

export interface User {
  id: number;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user: User;
    }
  }
}

// Anyone can sign in with any username and password. Each username gets the next number the first time it's used,
// kept in demo-users.json so users still see their chats after the app restarts.
const usersFile = fileURLToPath(new URL("../../demo-users.json", import.meta.url));
let userIds: Record<string, number>;
try {
  userIds = JSON.parse(readFileSync(usersFile, "utf8"));
} catch {
  userIds = {};
}

function signIn(name: string): User {
  const key = name.toLowerCase();
  if (!userIds[key]) {
    userIds[key] = Object.keys(userIds).length + 1;
    writeFileSync(usersFile, JSON.stringify(userIds, null, 2));
  }
  return { id: userIds[key], name };
}

// A fixed key is fine for this demo. A real deployment must load a secret key from configuration.
const signingKey = new TextEncoder().encode("hack-the-harness-demo-signing-key");

// Adds sign-in routes, then requires a signed-in user for everything after them.
export function auth() {
  const router = express.Router();
  router.use(cookieParser());
  router.use(express.urlencoded({ extended: false }));

  router.get("/login", (_req, res) => {
    res.send(loginPage());
  });

  router.post("/login", async (req, res) => {
    const name = String(req.body.username ?? "").trim().replace(/\s+/g, " ");

    if (!name) {
      return res.status(401).send(loginPage("Enter a username"));
    }

    const user = signIn(name);

    const jwt = await new SignJWT({ name: user.name })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(user.id))
      .setExpirationTime("8h")
      .sign(signingKey);

    res.cookie("auth", jwt, { httpOnly: true, sameSite: "lax" });
    res.redirect("/");
  });

  router.post("/logout", (_req, res) => {
    res.clearCookie("auth");
    res.redirect("/login");
  });

  router.use(requireUser);

  router.get("/api/me", (req, res) => {
    res.json(req.user);
  });

  return router;
}

// Sets req.user from the cookie. Otherwise, API calls get 401 and pages go to the login page.
const requireUser: RequestHandler = async (req, res, next) => {
  try {
    const { payload } = await jwtVerify(req.cookies.auth ?? "", signingKey);
    req.user = { id: Number(payload.sub), name: payload.name as string };
    next();
  } catch {
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ message: "Sign in required" });
    } else {
      res.redirect("/login");
    }
  }
};

function loginPage(error?: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sign in · Staff assistant</title>
  <style>
    body { margin: 0; height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f6f8fa; }
    form { display: grid; gap: 12px; width: 280px; }
    input, button { padding: 10px; border-radius: 6px; border: 1px solid #d0d7de; font: inherit; }
    button { background: #1f2328; color: white; border: none; cursor: pointer; }
    p { margin: 0; color: #cf222e; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Staff assistant</h1>
    ${error ? `<p>${error}</p>` : ""}
    <input name="username" placeholder="Demo: any username accepted" autofocus required>
    <input name="password" type="password" placeholder="Demo: any password accepted">
    <button>Sign in</button>
  </form>
</body>
</html>`;
}
