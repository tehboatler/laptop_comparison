/**
 * Normalize chassis material → grade + short label for UI.
 * Grades: plastic | hybrid | metal | premium
 */
const fs = require("fs");
const path = require("path");
const dataPath = path.join(__dirname, "..", "data.json");
const d = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const sheet = d.sheets.find((s) => String(s.name || "").toLowerCase().includes("laptop"));

function classifyMaterial(raw, model, id) {
  const s = String(raw || "").toLowerCase();
  const blob = `${s} ${model || ""} ${id || ""}`.toLowerCase();

  // Premium thin / unibody metal
  if (
    /cnc|unibody|magnesium|carbon fiber|full.?metal|aluminum chassis|aluminium chassis|metal unibody/.test(
      blob
    ) ||
    /zephyrus|blade|stealth|xps|macbook|framework|proart|yoga pro|omnibook|aero/.test(blob)
  ) {
    if (/plastic only|all plastic/.test(s)) {
      /* fall through */
    } else if (
      /cnc|unibody|magnesium|carbon|aluminum|aluminium|metal/.test(s) ||
      /zephyrus|blade|stealth|xps|macbook|framework|proart|yoga pro|omnibook/.test(blob)
    ) {
      return {
        grade: /macbook|blade|stealth|xps|framework|proart|zephyrus g1|yoga pro/.test(blob)
          ? "premium"
          : "metal",
        label:
          /macbook/.test(blob)
            ? "Aluminum unibody"
            : /framework/.test(blob)
              ? "Aluminum · repairable"
              : /cnc|magnesium|carbon/.test(s)
                ? String(raw).slice(0, 48)
                : "Metal chassis",
      };
    }
  }

  // Hybrid: metal lid + plastic base (common TUF/Legion/LOQ marketing)
  if (
    /aluminum lid|aluminium lid|metal lid|alloy lid|plastic base|polycarbonate base|reinforced plastic|metal lid \+/.test(
      s
    ) ||
    (/aluminum|aluminium|metal/.test(s) && /plastic|polycarbonate/.test(s))
  ) {
    return {
      grade: "hybrid",
      label: /lid/.test(s) ? "Metal lid · plastic base" : "Hybrid metal/plastic",
    };
  }

  // Thin mix
  if (/thin plastic\/metal|plastic\/metal mix|metal mix/.test(s)) {
    return { grade: "hybrid", label: "Thin plastic/metal mix" };
  }

  // Explicit plastic
  if (/plastic|polycarbonate/.test(s) || !s || s === "class") {
    // Legion / TUF sometimes higher feel but still plastic
    if (/legion|tuf|omen|strix/.test(blob) && /plastic/.test(s)) {
      return { grade: "plastic", label: "Plastic (reinforced gaming)" };
    }
    return { grade: "plastic", label: s.includes("plastic") ? "Plastic chassis" : "Plastic chassis (typical)" };
  }

  if (/aluminum|aluminium|metal|magnesium/.test(s)) {
    return { grade: "metal", label: String(raw).slice(0, 48) || "Metal chassis" };
  }

  return { grade: "plastic", label: String(raw).slice(0, 48) || "Plastic chassis (typical)" };
}

// Per-id overrides for known builds
const OVERRIDES = {
  lap_asus_zephyrus_g14_4060: { grade: "premium", label: "CNC aluminum" },
  lap_asus_zephyrus_g14_5060: { grade: "premium", label: "CNC aluminum" },
  lap_asus_zephyrus_g16_4070: { grade: "premium", label: "CNC aluminum / magnesium" },
  lap_razer_blade14_4060: { grade: "premium", label: "CNC aluminum unibody" },
  lap_msi_stealth16_4060: { grade: "premium", label: "Aluminum thin chassis" },
  lap_lenovo_yoga_pro9i_4060: { grade: "premium", label: "Aluminum / premium thin" },
  lap_asus_proart_p16_4060: { grade: "premium", label: "Aluminum creator chassis" },
  lap_dell_xps14_2026: { grade: "premium", label: "Aluminum CNC" },
  lap_hp_omnibook_ultra14: { grade: "premium", label: "Aluminum premium thin" },
  lap_apple_mbp14_m4: { grade: "premium", label: "Aluminum unibody" },
  lap_framework_16: { grade: "metal", label: "Aluminum · modular/repairable" },
  lap_asus_tuf_a14_4060: { grade: "hybrid", label: "Metal lid · tough plastic body" },
  lap_asus_tuf_a15_4060: { grade: "hybrid", label: "Metal lid · plastic body (MIL-STD)" },
  lap_asus_tuf_a15_5060: { grade: "hybrid", label: "Metal lid · plastic body (MIL-STD)" },
  lap_asus_tuf_a16_5050: { grade: "hybrid", label: "Metal lid · plastic body (MIL-STD)" },
  lap_asus_tuf_a16_5060: { grade: "hybrid", label: "Metal lid · plastic body (MIL-STD)" },
  lap_asus_tuf_f16_4050: { grade: "hybrid", label: "Metal lid · plastic body (MIL-STD)" },
  lap_asus_tuf_f16_5050: { grade: "hybrid", label: "Metal lid · plastic body (MIL-STD)" },
  lap_asus_tuf_f16_5060: { grade: "hybrid", label: "Metal lid · plastic body (MIL-STD)" },
  lap_lenovo_legion5_4060: { grade: "hybrid", label: "Metal lid · plastic body" },
  lap_lenovo_legion5_5060: { grade: "hybrid", label: "Metal lid · plastic body" },
  lap_lenovo_legion_pro5_5070: { grade: "hybrid", label: "Metal lid · plastic body" },
  lap_msi_thin15_4050: { grade: "hybrid", label: "Aluminum lid · plastic base" },
  lap_alienware_16_5060: { grade: "hybrid", label: "Aluminum lid · premium plastics" },
  lap_asus_strix_g16_5060: { grade: "plastic", label: "Plastic gaming (reinforced)" },
  lap_lenovo_loq_4050: { grade: "plastic", label: "Plastic gaming chassis" },
  lap_lenovo_loq_4060: { grade: "plastic", label: "Plastic gaming chassis" },
  lap_lenovo_loq_5060: { grade: "plastic", label: "Plastic gaming chassis" },
  lap_lenovo_loq_5050: { grade: "plastic", label: "Plastic gaming chassis" },
  lap_lenovo_loq_15_amd_5060: { grade: "plastic", label: "Plastic gaming chassis" },
  lap_acer_nitro_v15_4050: { grade: "plastic", label: "Plastic gaming chassis" },
  lap_acer_nitro_v15_5060: { grade: "plastic", label: "Plastic gaming chassis" },
};

let n = 0;
const counts = { plastic: 0, hybrid: 0, metal: 0, premium: 0 };
for (const row of sheet.rows) {
  const c = row.cells;
  const det = c.col_detail || {};
  if (!det.chassis) det.chassis = {};
  const o = OVERRIDES[row.id];
  const cls = o || classifyMaterial(det.chassis.material, c.col_model, row.id);
  det.chassis.material = det.chassis.material || cls.label;
  det.chassis.grade = cls.grade;
  det.chassis.grade_label = cls.label;
  c.col_detail = det;
  // optional sheet column for filtering later
  c.col_chassis_grade = cls.grade;
  counts[cls.grade] = (counts[cls.grade] || 0) + 1;
  n++;
}

// Add column if missing
const colIds = new Set((sheet.columns || []).map((x) => x.id));
if (!colIds.has("col_chassis_grade")) {
  const after = (sheet.columns || []).findIndex((x) => x.id === "col_weight");
  const col = {
    id: "col_chassis_grade",
    name: "Chassis grade",
    type: "select",
    width: 120,
    config: {
      options: [
        { id: "plastic", label: "Plastic", color: "#6b7280" },
        { id: "hybrid", label: "Hybrid (metal lid)", color: "#3b6cf0" },
        { id: "metal", label: "Metal", color: "#2a9d5c" },
        { id: "premium", label: "Premium metal", color: "#8b5cf6" },
      ],
    },
  };
  if (after >= 0) sheet.columns.splice(after + 1, 0, col);
  else sheet.columns.push(col);
}

fs.writeFileSync(dataPath, JSON.stringify(d, null, 2) + "\n");
console.log("Normalized chassis grade on", n, "laptops", counts);
