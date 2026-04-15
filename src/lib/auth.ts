import { SignJWT, jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "xcapital-flow-secret-key-2024"
);

export const COOKIE_NAME = "xcf_session";

// ─── Hardcoded credentials ────────────────────────────────────────────────────

const CREDENTIALS = {
  username: "admin",
  password: "admin123",
};

export function validateCredentials(username: string, password: string): boolean {
  return username === CREDENTIALS.username && password === CREDENTIALS.password;
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

export async function signToken(username: string): Promise<string> {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(SECRET);
}

export async function verifyToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}
