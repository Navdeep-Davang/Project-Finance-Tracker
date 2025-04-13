import { Express } from "express";
import { storage } from "./storage";
import { hashPassword } from "../utils/session";
import jwt from 'jsonwebtoken';
import dotenv from "dotenv";
import { comparePasswords } from "../utils/session";
import { UserRoleType } from "@shared/schema";

dotenv.config();

interface DecodedToken {
  userId: string;
  role: UserRoleType;
}

const JWT_SECRET = process.env.MY_JWT_SECRET!;
const REFRESH_TOKEN_SECRET = process.env.MY_REFRESH_TOKEN_SECRET!;
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || "15m"; // Default fallback
const REFRESH_TOKEN_EXPIRY_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRY_DAYS || "7", 10);

console.log('MY_JWT_SECRET:', process.env.MY_JWT_SECRET);
console.log('ACCESS_TOKEN_SECRET:', process.env.MY_ACCESS_TOKEN_SECRET);
console.log('REFRESH_TOKEN_SECRET:', process.env.MY_REFRESH_TOKEN_SECRET);

// Token generation functions
function generateAccessToken(user: { id: number; role: string }) {
  console.log("ACCESS_TOKEN_EXPIRY from .env →", process.env.ACCESS_TOKEN_EXPIRY);
  return jwt.sign(
    { userId: user.id.toString(), role: user.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'] }
  );
}

function generateRefreshToken(user: { id: number; role: string }) {
  return jwt.sign(
    { userId: user.id.toString(), role: user.role },
    REFRESH_TOKEN_SECRET,
    { expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d` }
  );
}


export function setupAuth(app: Express) {

  // 1. Register route
  app.post("/api/register", async (req, res) => {
    const { username, password, name, role } = req.body;

    try {
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const hashed = await hashPassword(password);
      const user = await storage.createUser({ username, password: hashed, name, role });

      req.session.userId = user.id;
      const { password: _, ...userWithoutPassword } = user;
      res.status(201).json(userWithoutPassword);
    } catch (err) {
      res.status(500).json({ message: "Registration failed", error: err });
    }
  });


  // 2. Login route
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = await storage.getUserByUsername(username);
    if (!user || !(await comparePasswords(password, user.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Store refresh token in DB
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
    await storage.saveRefreshToken(user.id, refreshToken, expiresAt);

    // Send refresh token in HttpOnly cookie, access token in body
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });

    console.log("Sending access token to client:", accessToken);
    res.json({ accessToken });
  });


  // 3. Refresh the JWT
  app.post("/api/refresh", async (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) return res.status(401).json({ message: "No refresh token" });

    try {
      const payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as DecodedToken;

      const dbToken = await storage.getRefreshToken(refreshToken);
      if (!dbToken || new Date(dbToken.expiresAt) < new Date()) {
        return res.status(403).json({ message: "Refresh token expired or invalid" });
      }

      const newAccessToken = generateAccessToken({ id: parseInt(payload.userId), role: payload.role });
      res.json({ accessToken: newAccessToken });
    } catch (err) {
      res.status(403).json({ message: "Invalid refresh token" });
    }
  });

  // 4. Logout route
  app.post("/api/logout", async (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    if (refreshToken) {
      await storage.deleteRefreshToken(refreshToken);
      res.clearCookie("refreshToken");
    }
    res.status(200).json({ message: "Logged out" });
  });
  
  // 5. Get current user session
  app.get("/api/user", async (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ message: "Not authenticated (no refresh token)" });
    }

    try {
      const payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as DecodedToken;
      const dbToken = await storage.getRefreshToken(refreshToken);

      if (!dbToken || new Date(dbToken.expiresAt) < new Date()) {
        return res.status(403).json({ message: "Refresh token invalid or expired" });
      }

      const user = await storage.getUser(parseInt(payload.userId));
      if (!user) return res.status(404).json({ message: "User not found" });

      const { password: _, ...userData } = user;
      return res.status(200).json(userData);
    } catch (err) {
      return res.status(403).json({ message: "Invalid token" });
    }
  });
}
