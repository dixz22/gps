// ============================================================
// KOORDINAT.JS — Advanced Geolocation Engine v2.0
// 6-Layer Reverse Geocoding Resolution for Indonesian Address
// Free & Open Source — no API key required
// ============================================================

const KoordinatEngine = (() => {

  // ─── INTERNAL STATE ────────────────────────────────────────
  let _onResult = null;
  let _onStatus = null;
  let _onError  = null;

  // ─── UTILITY ───────────────────────────────────────────────

  function cleanAdminName(str) {
    if (!str || str === "-") return "-";
    return str.toString()
      .replace(/^(kecamatan|distrik|kabupaten|kota|desa|kelurahan|provinsi|kel\.|kec\.)\s*/i, "")
      .replace(/\s+(kecamatan|distrik|kabupaten|kota|desa|kelurahan|provinsi)$/i, "")
      .trim();
  }

  function isDuplicate(a, b) {
    if (!a || !b || a === "-" || b === "-") return false;
    return cleanAdminName(a).toLowerCase() === cleanAdminName(b).toLowerCase();
  }

  function deepScanForKecamatan(addr) {
    for (let key in addr) {
      const val = addr[key];
      if (typeof val === "string") {
        const lower = val.toLowerCase();
        if (lower.startsWith("kecamatan ") || lower.startsWith("distrik ")) {
          return val;
        }
      }
    }
    return null;
  }

  function emitStatus(msg) {
    if (_onStatus) _onStatus(msg);
  }

  // ─── NOMINATIM FETCHER ─────────────────────────────────────

  async function fetchNominatim(url) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "KoordinatEngine/2.0 (koordinat-resolver)" }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // ─── 6-LAYER REVERSE GEOCODING ─────────────────────────────
  //
  // LAYER 1 — Nominatim zoom=18, direct field mapping
  // LAYER 2 — Deep scan nilai address untuk prefix "Kecamatan "
  // LAYER 3 — Nominatim zoom=13 (paksa level kecamatan)
  // LAYER 4 — Nominatim zoom=12 (zoom lebih luas)
  // LAYER 5 — Nominatim Search API (query desa + kabupaten)
  // LAYER 6 — BigDataCloud (sumber independen dari OSM)
  //
  async function resolveAddress(lat, lon) {
    const result = {
      lat, lon,
      desa: "-", kecamatan: "-", kabupaten: "-", provinsi: "-",
      layer: "none",
      formatted: null
    };

    // ── LAYER 1 + 2: Nominatim z=18 ──
    emitStatus("Resolving address (layer 1/6)...");
    const z18 = await fetchNominatim(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&accept-language=id`
    );

    if (z18 && z18.address) {
      const a = z18.address;
      result.desa      = a.village || a.suburb || a.neighbourhood || a.hamlet || a.quarter || a.residential || "-";
      result.kabupaten = a.regency || a.city || a.county || a.municipality || "-";
      result.provinsi  = a.state || a.province || "-";
      result.layer     = "nominatim_z18";

      let kec = a.subdistrict || a.district || a.city_district || a.town || null;
      if (!kec || isDuplicate(kec, result.kabupaten)) {
        kec = deepScanForKecamatan(a) || kec;
      }
      if (kec && !isDuplicate(kec, result.kabupaten)) {
        result.kecamatan = kec;
      }
    }

    // ── LAYER 3: z=13 ──
    if (result.kecamatan === "-") {
      emitStatus("Resolving address (layer 3/6)...");
      const z13 = await fetchNominatim(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=13&addressdetails=1&accept-language=id`
      );
      if (z13 && z13.address) {
        const a3 = z13.address;
        let kec3 = a3.subdistrict || a3.district || a3.city_district || a3.town || deepScanForKecamatan(a3) || null;
        if (!kec3 && z13.display_name) {
          const parts = z13.display_name.split(",").map(s => s.trim());
          const found = parts.find(p => /^(kecamatan|distrik)\s/i.test(p));
          if (found) kec3 = found;
        }
        if (kec3 && !isDuplicate(kec3, result.kabupaten)) {
          result.kecamatan = kec3;
          result.layer = "nominatim_z13";
        }
        if (result.kabupaten === "-") {
          result.kabupaten = a3.regency || a3.city || a3.county || "-";
        }
      }
    }

    // ── LAYER 4: z=12 ──
    if (result.kecamatan === "-") {
      emitStatus("Resolving address (layer 4/6)...");
      const z12 = await fetchNominatim(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=12&addressdetails=1&accept-language=id`
      );
      if (z12 && z12.address) {
        const a4 = z12.address;
        let kec4 = a4.subdistrict || a4.district || a4.town || deepScanForKecamatan(a4) || null;
        if (!kec4 && z12.display_name) {
          const parts = z12.display_name.split(",").map(s => s.trim());
          const found = parts.find(p => /^(kecamatan|distrik)\s/i.test(p));
          if (found) kec4 = found;
        }
        if (kec4 && !isDuplicate(kec4, result.kabupaten)) {
          result.kecamatan = kec4;
          result.layer = "nominatim_z12";
        }
      }
    }

    // ── LAYER 5: Search API ──
    if (result.kecamatan === "-" && result.desa !== "-" && result.kabupaten !== "-") {
      emitStatus("Resolving address (layer 5/6)...");
      const query = encodeURIComponent(`${cleanAdminName(result.desa)}, ${cleanAdminName(result.kabupaten)}, Indonesia`);
      const search5 = await fetchNominatim(
        `https://nominatim.openstreetmap.org/search?format=json&q=${query}&addressdetails=1&limit=3&accept-language=id`
      );
      if (search5 && search5.length > 0) {
        for (const r of search5) {
          if (!r.address) continue;
          const a5 = r.address;
          let kec5 = a5.subdistrict || a5.district || a5.city_district || deepScanForKecamatan(a5) || null;
          if (!kec5 && r.display_name) {
            const parts = r.display_name.split(",").map(s => s.trim());
            const found = parts.find(p => /^(kecamatan|distrik)\s/i.test(p));
            if (found) kec5 = found;
          }
          if (kec5 && !isDuplicate(kec5, result.kabupaten)) {
            result.kecamatan = kec5;
            result.layer = "nominatim_search";
            break;
          }
        }
      }
    }

    // ── LAYER 6: BigDataCloud ──
    if (result.kecamatan === "-") {
      emitStatus("Resolving address (layer 6/6)...");
      try {
        const r6 = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=id`
        );
        if (r6.ok) {
          const d6 = await r6.json();
          if (d6.localityInfo && d6.localityInfo.informative) {
            const info = d6.localityInfo.informative;
            const kecEntry = info.find(i => i.order === 5 || i.order === 6);
            if (kecEntry && kecEntry.name && !isDuplicate(kecEntry.name, result.kabupaten)) {
              result.kecamatan = kecEntry.name;
              result.layer = "bigdatacloud";
            }
          }
          if (result.desa === "-")      result.desa      = d6.locality || "-";
          if (result.kabupaten === "-") result.kabupaten  = d6.city || "-";
          if (result.provinsi === "-")  result.provinsi   = d6.principalSubdivision || "-";
        }
      } catch { /* silent fail */ }
    }

    // ── CLEANUP ──
    result.desa      = cleanAdminName(result.desa);
    result.kecamatan = cleanAdminName(result.kecamatan);
    result.kabupaten = cleanAdminName(result.kabupaten);
    result.provinsi  = cleanAdminName(result.provinsi);

    if (isDuplicate(result.kecamatan, result.kabupaten)) result.kecamatan = "-";
    if (isDuplicate(result.desa, result.kecamatan))      result.desa = "-";

    // ── FORMAT ALAMAT ──
    const parts = [result.desa, result.kecamatan, result.kabupaten, result.provinsi]
      .filter(v => v && v !== "-");
    result.formatted = parts.join(", ") || "Alamat tidak ditemukan";

    return result;
  }

  // ─── GPS ENGINE ────────────────────────────────────────────

  async function getCoordinates() {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("Browser tidak mendukung GPS / Geolocation API."));
        return;
      }

      let bestPos    = null;
      let watchId    = null;
      let timeoutId  = null;
      let settled    = false;

      function finish(pos) {
        if (settled) return;
        settled = true;
        if (watchId)   navigator.geolocation.clearWatch(watchId);
        if (timeoutId) clearTimeout(timeoutId);

        if (!pos) {
          reject(new Error("Tidak dapat memperoleh sinyal GPS. Coba di luar ruangan."));
          return;
        }

        resolve({
          lat:      pos.coords.latitude,
          lon:      pos.coords.longitude,
          accuracy: pos.coords.accuracy
        });
      }

      emitStatus("Menunggu sinyal GPS...");

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (!bestPos || pos.coords.accuracy < bestPos.coords.accuracy) {
            bestPos = pos;
            emitStatus(`Sinyal ditemukan, akurasi ±${Math.round(pos.coords.accuracy)}m...`);
          }
          if (bestPos.coords.accuracy <= 15) finish(bestPos);
        },
        (err) => {
          let msg = "Tidak dapat mengakses lokasi.";
          if (err.code === 1) msg = "Izin lokasi ditolak. Aktifkan izin di browser Anda.";
          if (err.code === 2) msg = "Sinyal GPS tidak tersedia saat ini.";
          if (err.code === 3) msg = "Waktu permintaan GPS habis.";
          if (!bestPos && !settled) reject(new Error(msg));
          else if (bestPos && !settled) finish(bestPos);
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );

      // Timeout 8 detik — pakai pos terbaik
      timeoutId = setTimeout(() => {
        if (bestPos && !settled) {
          emitStatus("Menggunakan sinyal GPS terbaik yang tersedia...");
          finish(bestPos);
        } else if (!settled) {
          settled = true;
          if (watchId) navigator.geolocation.clearWatch(watchId);
          reject(new Error("GPS timeout. Pastikan izin lokasi diberikan dan coba di tempat terbuka."));
        }
      }, 8000);
    });
  }

  // ─── PUBLIC API ────────────────────────────────────────────

  return {

    /**
     * Callback saat ada update status / progress.
     * @param {Function} fn - fn(message: string)
     */
    onStatus(fn) { _onStatus = fn; return this; },

    /**
     * Jalankan deteksi koordinat + reverse geocoding.
     * @returns {Promise<Object>} result — { lat, lon, accuracy, desa, kecamatan, kabupaten, provinsi, formatted, layer }
     */
    async detect() {
      emitStatus("Meminta izin lokasi...");
      const gps = await getCoordinates();

      emitStatus("Koordinat diperoleh. Mendeteksi wilayah...");
      const address = await resolveAddress(gps.lat, gps.lon);

      return {
        lat:       gps.lat,
        lon:       gps.lon,
        accuracy:  Math.round(gps.accuracy),
        desa:      address.desa,
        kecamatan: address.kecamatan,
        kabupaten: address.kabupaten,
        provinsi:  address.provinsi,
        formatted: address.formatted,
        layer:     address.layer
      };
    },

    /**
     * Format koordinat sebagai DMS (Derajat Menit Detik).
     */
    toDMS(decimal, isLat) {
      const abs = Math.abs(decimal);
      const d   = Math.floor(abs);
      const mf  = (abs - d) * 60;
      const m   = Math.floor(mf);
      const s   = ((mf - m) * 60).toFixed(2);
      const dir = isLat
        ? (decimal >= 0 ? "N" : "S")
        : (decimal >= 0 ? "E" : "W");
      return `${d}° ${m}' ${s}" ${dir}`;
    },

    /**
     * Buat link Google Maps dari koordinat.
     */
    toMapsURL(lat, lon) {
      return `https://maps.google.com/?q=${lat},${lon}`;
    }
  };

})();