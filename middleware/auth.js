const jwt = require("jsonwebtoken");
const db = require("../db");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || String(secret).trim().length < 24) {
    throw new Error("JWT_SECRET is missing or too short. Use at least 24 random characters.");
  }
  return secret;
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const parts = header.split(" ");
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1];
  return null;
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing bearer token" });

    const payload = jwt.verify(token, getJwtSecret());
    const userId = Number(payload.sub || payload.user_id);

    if (!Number.isInteger(userId)) {
      return res.status(401).json({ error: "Invalid token subject" });
    }

    const result = await db.query(
      `
      SELECT id, email, display_name, role, is_active, created_at, updated_at, last_login_at
      FROM portfolio_users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    const user = result.rows[0];
    if (!user || user.is_active === false) {
      return res.status(401).json({ error: "User is not active" });
    }

    req.authUser = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Session expired" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    console.error(err);
    res.status(500).json({ error: "Authentication failed", details: err.message });
  }
}

function signUserToken(user) {
  return jwt.sign(
    {
      user_id: user.id,
      email: user.email,
      role: user.role || "user"
    },
    getJwtSecret(),
    {
      subject: String(user.id),
      expiresIn: process.env.JWT_EXPIRES_IN || "30d"
    }
  );
}

module.exports = {
  requireAuth,
  signUserToken
};
