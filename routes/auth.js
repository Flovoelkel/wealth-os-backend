const router = require("express").Router();
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth, signUserToken } = require("../middleware/auth");

const AUTH_VERSION = "auth-v3.4.6-public-signup";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function validatePassword(password) {
  const text = String(password || "");
  if (text.length < 8) {
    throw new Error("Passwort muss mindestens 8 Zeichen haben.");
  }
  return text;
}

function requireAdminTokenFromBody(req) {
  const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN;
  if (!expectedToken) throw new Error("ADMIN_DASHBOARD_TOKEN is not configured");

  const providedToken =
    req.body?.admin_token ||
    req.query.admin_token ||
    req.headers["x-admin-token"];

  if (providedToken !== expectedToken) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

function requireSignupCode(req) {
  const publicSignupEnabled = String(process.env.ALLOW_PUBLIC_PORTFOLIO_SIGNUP || "").toLowerCase() === "true";
  if (publicSignupEnabled) return;

  const expectedCode = process.env.PORTFOLIO_SIGNUP_CODE;

  // Closed signup remains possible when public signup is disabled.
  if (!expectedCode) {
    const err = new Error("Registrierung ist noch nicht freigeschaltet. Setze ALLOW_PUBLIC_PORTFOLIO_SIGNUP=true oder PORTFOLIO_SIGNUP_CODE in Render.");
    err.statusCode = 403;
    throw err;
  }

  const providedCode = req.body?.signup_code || req.query.signup_code || req.headers["x-signup-code"];
  if (providedCode !== expectedCode) {
    const err = new Error("Ungültiger Registrierungscode.");
    err.statusCode = 401;
    throw err;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role || "user",
    created_at: user.created_at || null,
    updated_at: user.updated_at || null,
    last_login_at: user.last_login_at || null
  };
}

router.post("/register", async (req, res) => {
  try {
    requireSignupCode(req);

    const email = cleanEmail(req.body?.email);
    const password = validatePassword(req.body?.password);
    const displayName = cleanText(req.body?.display_name, email.split("@")[0]);

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Bitte eine gültige E-Mail-Adresse verwenden." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.query(
      `
      INSERT INTO portfolio_users (email, password_hash, display_name, role, is_active, updated_at)
      VALUES ($1, $2, $3, 'user', true, NOW())
      RETURNING id, email, display_name, role, is_active, created_at, updated_at, last_login_at
      `,
      [email, passwordHash, displayName]
    );

    const user = result.rows[0];
    const token = signUserToken(user);

    res.status(201).json({
      auth_version: AUTH_VERSION,
      ok: true,
      token,
      user: publicUser(user)
    });
  } catch (err) {
    const status = err.statusCode || (String(err.message).includes("duplicate") ? 409 : 400);
    res.status(status).json({ error: "Registrierung fehlgeschlagen", details: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!EMAIL_REGEX.test(email) || !password) {
      return res.status(400).json({ error: "E-Mail und Passwort sind erforderlich." });
    }

    const result = await db.query(
      `
      SELECT id, email, password_hash, display_name, role, is_active, created_at, updated_at, last_login_at
      FROM portfolio_users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    const user = result.rows[0];
    if (!user || !user.password_hash || user.is_active === false) {
      return res.status(401).json({ error: "Login fehlgeschlagen." });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Login fehlgeschlagen." });

    await db.query("UPDATE portfolio_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1", [user.id]);
    const token = signUserToken(user);

    res.json({
      auth_version: AUTH_VERSION,
      ok: true,
      token,
      user: publicUser(user)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login error", details: err.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  res.json({ auth_version: AUTH_VERSION, ok: true, user: publicUser(req.authUser) });
});

router.post("/claim-owner", async (req, res) => {
  try {
    requireAdminTokenFromBody(req);

    const email = cleanEmail(req.body?.email);
    const password = validatePassword(req.body?.password);
    const displayName = cleanText(req.body?.display_name, "Portfolio Owner");

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Bitte eine gültige E-Mail-Adresse verwenden." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.query(
      `
      UPDATE portfolio_users
      SET email = $1,
          password_hash = $2,
          display_name = $3,
          role = 'admin',
          is_active = true,
          updated_at = NOW()
      WHERE id = 1
      RETURNING id, email, display_name, role, is_active, created_at, updated_at, last_login_at
      `,
      [email, passwordHash, displayName]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Owner user id=1 wurde nicht gefunden. Erst SQL-Migration ausführen." });
    }

    const user = result.rows[0];
    const token = signUserToken(user);

    res.json({
      auth_version: AUTH_VERSION,
      ok: true,
      token,
      user: publicUser(user)
    });
  } catch (err) {
    const status = err.statusCode || 400;
    res.status(status).json({ error: "Owner claim failed", details: err.message });
  }
});

module.exports = router;
