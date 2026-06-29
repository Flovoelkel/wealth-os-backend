const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { cleanText, parseJsonArray, parseJsonObject, toNumber, safeError, buildGameStateForUser } = require("./game-helpers");

const MAX_PROJECT_IMAGES = 8;
const MAX_IMAGE_DATA_URL_LENGTH = 700000;

function positiveAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Bitte einen positiven Betrag verwenden.");
  return Number(n.toFixed(2));
}

function normalizeImages(images) {
  return parseJsonArray(images).slice(0, MAX_PROJECT_IMAGES).map((item, index) => {
    const obj = typeof item === "string" ? { image_url: item } : parseJsonObject(item);
    const dataUrl = cleanText(obj.image_data_url, null, MAX_IMAGE_DATA_URL_LENGTH);
    return {
      image_url: cleanText(obj.image_url, null, 1200),
      image_data_url: dataUrl && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl) ? dataUrl : null,
      image_alt: cleanText(obj.image_alt, "Projektbild", 180),
      sort_order: Number.isInteger(Number(obj.sort_order)) ? Number(obj.sort_order) : index
    };
  }).filter((item) => item.image_url || item.image_data_url);
}

function projectSelectSql(whereSql = "p.visibility = 'public'") {
  return `
    SELECT
      p.*,
      u.display_name,
      gp.alias,
      COALESCE(s.supported_amount,0)::numeric AS supported_amount,
      COALESCE(s.support_count,0)::int AS support_count,
      COALESCE(img.images,'[]'::jsonb) AS images
    FROM crowdfunding_projects p
    JOIN portfolio_users u ON u.id = p.owner_user_id
    LEFT JOIN game_profiles gp ON gp.user_id = p.owner_user_id
    LEFT JOIN (
      SELECT project_id, COALESCE(SUM(amount),0) AS supported_amount, COUNT(*)::int AS support_count
      FROM crowdfunding_supports
      GROUP BY project_id
    ) s ON s.project_id = p.id
    LEFT JOIN (
      SELECT project_id,
        jsonb_agg(
          jsonb_build_object(
            'id', id,
            'image_url', image_url,
            'image_data_url', image_data_url,
            'image_alt', image_alt,
            'sort_order', sort_order
          ) ORDER BY sort_order ASC, id ASC
        ) AS images
      FROM crowdfunding_project_images
      GROUP BY project_id
    ) img ON img.project_id = p.id
    WHERE ${whereSql}
  `;
}

async function liquidAssetsQuery(client, userId, options = {}) {
  const sourceAssetId = options.sourceAssetId ? Number(options.sourceAssetId) : null;
  const forUpdate = options.forUpdate ? "FOR UPDATE" : "";
  const params = [userId];
  let sourceFilter = "";
  if (sourceAssetId) {
    params.push(sourceAssetId);
    sourceFilter = `AND id = $${params.length}`;
  }

  const result = await client.query(
    `
    SELECT id, name, manual_value, asset_details, asset_game_class, is_liquid
    FROM assets
    WHERE user_id = $1
      AND mode = 'portfolio'
      AND type = 'manual'
      AND COALESCE(manual_value,0) > 0
      ${sourceFilter}
      AND (
        is_liquid = true
        OR asset_game_class = 'neutral'
        OR asset_details->>'liquidity_class' = 'liquid'
        OR lower(COALESCE(name,'')) LIKE '%cash%'
        OR lower(COALESCE(name,'')) LIKE '%tagesgeld%'
        OR lower(COALESCE(name,'')) LIKE '%geldbestand%'
        OR lower(COALESCE(name,'')) LIKE '%konto%'
      )
    ORDER BY manual_value DESC, id ASC
    ${forUpdate}
    `,
    params
  );
  return result.rows || [];
}

async function withTransaction(callback) {
  if (typeof db.connect === "function") {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Fallback for simple db wrappers without connect().
  return callback(db);
}

router.get("/", async (req, res) => {
  try {
    const status = cleanText(req.query.status, "active", 40);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const result = await db.query(
      `${projectSelectSql("p.visibility = 'public' AND ($2 = 'all' OR p.status = $2)")}
       ORDER BY p.created_at DESC
       LIMIT $1`,
      [limit, status]
    );
    res.json({ ok: true, projects: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Projekte konnten nicht geladen werden." });
  }
});

router.get("/liquidity", requireAuth, async (req, res) => {
  try {
    const assets = await liquidAssetsQuery(db, req.authUser.id);
    const liquidBalance = assets.reduce((sum, asset) => sum + Number(asset.manual_value || 0), 0);
    res.json({
      ok: true,
      liquid_balance: Number(liquidBalance.toFixed(2)),
      liquid_assets: assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        value: Number(asset.manual_value || 0),
        asset_game_class: asset.asset_game_class,
        is_liquid: asset.is_liquid
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Liquider Geldbestand konnte nicht geladen werden." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `${projectSelectSql("p.owner_user_id = $1")}
       ORDER BY p.created_at DESC`,
      [req.authUser.id]
    );
    res.json({ ok: true, projects: result.rows.map((row) => ({ ...row, is_owner: true })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Eigene Projekte konnten nicht geladen werden." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return safeError(res, 400, "Ungültige Projekt-ID.");
    const result = await db.query(`${projectSelectSql("p.id = $1 AND (p.visibility = 'public' OR p.owner_user_id = $2)")} LIMIT 1`, [id, req.authUser?.id || 0]);
    if (!result.rows.length) return safeError(res, 404, "Projekt wurde nicht gefunden.");
    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Projekt konnte nicht geladen werden." });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const title = cleanText(req.body.title, null, 180);
    if (!title) return safeError(res, 400, "Projektname fehlt.");

    const category = cleanText(req.body.category, "Sonstiges", 80);
    const description = cleanText(req.body.description, "", 1200);
    const longDescription = cleanText(req.body.long_description, "", 8000);
    const targetAmount = Math.max(0, toNumber(req.body.target_amount, 0));
    const productExists = req.body.product_exists === true;
    const productUrl = cleanText(req.body.product_url, null, 1200);
    const visibility = cleanText(req.body.visibility, "public", 40) === "private" ? "private" : "public";
    const images = normalizeImages(req.body.images || req.body.project_images);

    const project = await withTransaction(async (client) => {
      const projectResult = await client.query(
        `
        INSERT INTO crowdfunding_projects (
          owner_user_id, title, category, description, long_description, target_amount,
          product_exists, product_url, status, visibility, image_urls, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10::jsonb,NOW(),NOW())
        RETURNING *
        `,
        [req.authUser.id, title, category, description, longDescription, targetAmount, productExists, productUrl, visibility, JSON.stringify(images)]
      );

      const insertedImages = [];
      for (const image of images) {
        const imageResult = await client.query(
          `INSERT INTO crowdfunding_project_images (project_id, image_url, image_data_url, image_alt, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
          [projectResult.rows[0].id, image.image_url, image.image_data_url, image.image_alt, image.sort_order]
        );
        insertedImages.push(imageResult.rows[0]);
      }

      return { ...projectResult.rows[0], images: insertedImages };
    });

    res.status(201).json({ ok: true, project });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Projekt konnte nicht angelegt werden." });
  }
});

router.post("/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return safeError(res, 400, "Ungültige Projekt-ID.");
    const owned = await db.query("SELECT * FROM crowdfunding_projects WHERE id = $1 LIMIT 1", [id]);
    if (!owned.rows.length) return safeError(res, 404, "Projekt wurde nicht gefunden.");
    const isOwner = Number(owned.rows[0].owner_user_id) === Number(req.authUser.id);
    const isAdmin = String(req.authUser.role || "").toLowerCase() === "admin";
    if (!isOwner && !isAdmin) return safeError(res, 403, "Du kannst nur eigene Projekte bearbeiten.");

    const fields = [];
    const values = [];
    const add = (field, value, cast = "") => {
      if (value === undefined) return;
      values.push(value);
      fields.push(`${field} = $${values.length}${cast}`);
    };

    add("title", req.body.title === undefined ? undefined : cleanText(req.body.title, owned.rows[0].title, 180));
    add("category", req.body.category === undefined ? undefined : cleanText(req.body.category, owned.rows[0].category, 80));
    add("description", req.body.description === undefined ? undefined : cleanText(req.body.description, "", 1200));
    add("long_description", req.body.long_description === undefined ? undefined : cleanText(req.body.long_description, "", 8000));
    add("target_amount", req.body.target_amount === undefined ? undefined : Math.max(0, toNumber(req.body.target_amount, 0)));
    add("product_exists", req.body.product_exists === undefined ? undefined : req.body.product_exists === true);
    add("product_url", req.body.product_url === undefined ? undefined : cleanText(req.body.product_url, null, 1200));
    add("status", req.body.status === undefined ? undefined : cleanText(req.body.status, "active", 40));
    add("visibility", req.body.visibility === undefined ? undefined : (cleanText(req.body.visibility, "public", 40) === "private" ? "private" : "public"));

    if (req.body.images !== undefined || req.body.project_images !== undefined) {
      const images = normalizeImages(req.body.images || req.body.project_images);
      add("image_urls", JSON.stringify(images), "::jsonb");
      await db.query("DELETE FROM crowdfunding_project_images WHERE project_id = $1", [id]);
      for (const image of images) {
        await db.query(
          `INSERT INTO crowdfunding_project_images (project_id, image_url, image_data_url, image_alt, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,NOW())`,
          [id, image.image_url, image.image_data_url, image.image_alt, image.sort_order]
        );
      }
    }

    if (!fields.length) return safeError(res, 400, "Keine Änderungen angegeben.");
    values.push(id);
    const result = await db.query(`UPDATE crowdfunding_projects SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values);
    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Projekt konnte nicht gespeichert werden." });
  }
});

router.post("/:id/images", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return safeError(res, 400, "Ungültige Projekt-ID.");
    const project = await db.query("SELECT * FROM crowdfunding_projects WHERE id = $1 LIMIT 1", [id]);
    if (!project.rows.length) return safeError(res, 404, "Projekt wurde nicht gefunden.");
    const isOwner = Number(project.rows[0].owner_user_id) === Number(req.authUser.id);
    const isAdmin = String(req.authUser.role || "").toLowerCase() === "admin";
    if (!isOwner && !isAdmin) return safeError(res, 403, "Du kannst nur eigene Projekte bearbeiten.");

    const images = normalizeImages(req.body.images || [req.body]);
    const inserted = [];
    for (const image of images) {
      const result = await db.query(
        `INSERT INTO crowdfunding_project_images (project_id, image_url, image_data_url, image_alt, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
        [id, image.image_url, image.image_data_url, image.image_alt, image.sort_order]
      );
      inserted.push(result.rows[0]);
    }

    const allImages = await db.query(
      `SELECT jsonb_agg(jsonb_build_object('id', id, 'image_url', image_url, 'image_data_url', image_data_url, 'image_alt', image_alt, 'sort_order', sort_order) ORDER BY sort_order ASC, id ASC) AS images FROM crowdfunding_project_images WHERE project_id = $1`,
      [id]
    );
    await db.query("UPDATE crowdfunding_projects SET image_urls = COALESCE($2::jsonb,'[]'::jsonb), updated_at = NOW() WHERE id = $1", [id, JSON.stringify(allImages.rows[0]?.images || [])]);

    res.status(201).json({ ok: true, images: inserted });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Bild konnte nicht gespeichert werden." });
  }
});

router.post("/:id/support", requireAuth, async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) return safeError(res, 400, "Ungültige Projekt-ID.");
    const amount = positiveAmount(req.body.amount);
    const sourceAssetId = req.body.source_asset_id ? Number(req.body.source_asset_id) : null;

    const result = await withTransaction(async (client) => {
      const projectResult = await client.query("SELECT * FROM crowdfunding_projects WHERE id = $1 AND status = 'active' FOR UPDATE", [projectId]);
      const project = projectResult.rows[0];
      if (!project) throw new Error("Projekt wurde nicht gefunden oder ist nicht aktiv.");
      if (Number(project.owner_user_id) === Number(req.authUser.id)) throw new Error("Eigene Projekte können nicht unterstützt werden.");

      let liquidAssets = await liquidAssetsQuery(client, req.authUser.id, { sourceAssetId, forUpdate: true });
      if (sourceAssetId && !liquidAssets.length) throw new Error("Das gewählte liquide Asset wurde nicht gefunden oder hat keinen verfügbaren Geldbestand.");

      // If no source was selected, use all eligible liquid assets in descending value order.
      if (!sourceAssetId) liquidAssets = await liquidAssetsQuery(client, req.authUser.id, { forUpdate: true });
      const liquidBalance = liquidAssets.reduce((sum, asset) => sum + Number(asset.manual_value || 0), 0);

      if (liquidBalance < amount) {
        throw new Error(`Nicht genug liquider Geldbestand. Verfügbar: ${Math.floor(liquidBalance)} €.`);
      }

      let remaining = amount;
      const debited = [];
      for (const asset of liquidAssets) {
        if (remaining <= 0) break;
        const current = Number(asset.manual_value || 0);
        const take = Math.min(current, remaining);
        const nextValue = Number((current - take).toFixed(2));
        const details = parseJsonObject(asset.asset_details);
        details.last_crowdfunding_debit = { project_id: projectId, amount: take, at: new Date().toISOString() };
        await client.query(
          "UPDATE assets SET manual_value = $3, asset_details = $4::jsonb WHERE user_id = $1 AND id = $2",
          [req.authUser.id, asset.id, nextValue, JSON.stringify(details)]
        );
        debited.push({ asset_id: asset.id, name: asset.name, amount: take, remaining_value: nextValue });
        remaining = Number((remaining - take).toFixed(2));
      }

      const support = await client.query(
        `
        INSERT INTO crowdfunding_supports (project_id, supporter_user_id, amount, source_asset_id, support_type, debited_assets, created_at)
        VALUES ($1,$2,$3,$4,'demo_support',$5::jsonb,NOW())
        RETURNING *
        `,
        [projectId, req.authUser.id, amount, debited[0]?.asset_id || null, JSON.stringify(debited)]
      );

      await client.query(
        "UPDATE crowdfunding_projects SET demo_current_amount = COALESCE(demo_current_amount,0) + $2, updated_at = NOW() WHERE id = $1",
        [projectId, amount]
      );

      const asset = await client.query(
        `
        INSERT INTO assets (user_id, name, mode, type, quantity, manual_value, price_currency, live_enabled, data_provider, asset_game_class, public_visibility, is_liquid, asset_details)
        VALUES ($1,$2,'portfolio','manual',1,$3,'EUR',false,NULL,'crowdfunding','private',false,$4::jsonb)
        RETURNING *
        `,
        [
          req.authUser.id,
          `Crowdfunding: ${project.title}`,
          amount,
          JSON.stringify({
            kind: "crowdfunding_project",
            game_class: "crowdfunding",
            project_id: projectId,
            support_id: support.rows[0].id,
            original_amount: amount,
            source_asset_ids: debited.map((item) => item.asset_id),
            project_title: project.title,
            project_public_id: project.public_id || null
          })
        ]
      );

      await client.query("UPDATE crowdfunding_supports SET resulting_asset_id = $2 WHERE id = $1", [support.rows[0].id, asset.rows[0].id]).catch(() => {});

      return { support: support.rows[0], asset: asset.rows[0], debited, project };
    });

    const state = await buildGameStateForUser(req.authUser);
    res.status(201).json({ ok: true, ...result, game_state: state });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: err.message || "Projekt konnte nicht unterstützt werden." });
  }
});

module.exports = router;
