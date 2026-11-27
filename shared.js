/**
 * Shared state, storage, and course-matching logic for Фильтр курсов СДО.
 * Works both in browser extension scripts and in Node.js unit tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.MPCHShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const STORAGE_KEY = 'mpch_state_v1';
  const CATALOG_KEY = 'mpch_known_courses_v1';

  function createDefaultState() {
    return {
      enabled: true,
      hiddenCourses: {},
      titleRules: [],
      showHiddenInline: false
    };
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function extractCourseId(href) {
    if (!href) return null;
    const match = String(href).match(/[?&]id=(\d+)/i);
    return match ? match[1] : null;
  }

  function sanitizeState(raw) {
    const base = createDefaultState();
    if (!raw || typeof raw !== 'object') return base;

    base.enabled = raw.enabled !== false;
    base.showHiddenInline = Boolean(raw.showHiddenInline);

    if (raw.hiddenCourses && typeof raw.hiddenCourses === 'object' && !Array.isArray(raw.hiddenCourses)) {
      for (const [id, entry] of Object.entries(raw.hiddenCourses)) {
        const cleanId = String(id).trim();
        if (!cleanId) continue;
        if (entry && typeof entry === 'object') {
          base.hiddenCourses[cleanId] = {
            id: cleanId,
            name: String(entry.name || `Курс #${cleanId}`).trim(),
            category: String(entry.category || '').trim(),
            addedAt: Number(entry.addedAt) || Date.now()
          };
        }
      }
    }

    if (Array.isArray(raw.titleRules)) {
      base.titleRules = dedupeRules(raw.titleRules);
    }

    return base;
  }

  function dedupeRules(rules) {
    const seen = new Set();
    const out = [];
    for (const item of rules) {
      const trimmed = String(item || '').replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(trimmed);
      }
    }
    return out;
  }

  function parseRulesText(text) {
    return dedupeRules(String(text || '').split(/\r?\n/));
  }

  function formatRulesText(rules) {
    return Array.isArray(rules) ? rules.join('\n') : '';
  }

  /**
   * Matches course name against titleRules.
   * Rules starting with "=" require an exact (case-insensitive) match.
   * All other rules match by substring (case-insensitive).
   */
  function matchCourseRule(courseName, titleRules) {
    const normName = normalizeText(courseName);
    if (!normName || !Array.isArray(titleRules)) return null;

    for (const rule of titleRules) {
      const rawRule = String(rule || '').trim();
      if (!rawRule) continue;

      if (rawRule.startsWith('=')) {
        const exactTarget = normalizeText(rawRule.slice(1));
        if (exactTarget && normName === exactTarget) {
          return rawRule;
        }
      } else {
        const subTarget = normalizeText(rawRule);
        if (subTarget && normName.includes(subTarget)) {
          return rawRule;
        }
      }
    }
    return null;
  }

  function isCourseHidden(course, state) {
    if (!state || !state.enabled || !course) {
      return { hidden: false, reason: null, rule: null };
    }
    const id = course.id ? String(course.id) : null;
    if (id && state.hiddenCourses && state.hiddenCourses[id]) {
      return { hidden: true, reason: 'manual', rule: null };
    }
    const matchedRule = matchCourseRule(course.name, state.titleRules);
    if (matchedRule) {
      return { hidden: true, reason: 'rule', rule: matchedRule };
    }
    return { hidden: false, reason: null, rule: null };
  }

  // Firefox предоставляет promise-API как `browser`, Chrome — как `chrome`.
  const api =
    typeof browser !== 'undefined' && browser.storage
      ? browser
      : typeof chrome !== 'undefined'
        ? chrome
        : null;

  function getStorageArea() {
    if (api && api.storage) {
      return api.storage.sync || api.storage.local;
    }
    return null;
  }

  function getLocalArea() {
    if (api && api.storage) {
      return api.storage.local || api.storage.sync;
    }
    return null;
  }

  async function loadState() {
    const syncArea = getStorageArea();
    const localArea = getLocalArea();
    if (!syncArea && !localArea) return createDefaultState();

    try {
      const result = await syncArea.get(STORAGE_KEY);
      if (result && result[STORAGE_KEY]) {
        return sanitizeState(result[STORAGE_KEY]);
      }
    } catch (_) {
      // Fall back to local storage if sync is unavailable or disabled.
    }

    if (localArea && localArea !== syncArea) {
      try {
        const localRes = await localArea.get(STORAGE_KEY);
        if (localRes && localRes[STORAGE_KEY]) {
          return sanitizeState(localRes[STORAGE_KEY]);
        }
      } catch (_) {}
    }

    return createDefaultState();
  }

  async function saveState(nextState) {
    const clean = sanitizeState(nextState);
    const syncArea = getStorageArea();
    const localArea = getLocalArea();
    if (!syncArea && !localArea) return clean;

    let saved = false;
    if (syncArea) {
      try {
        await syncArea.set({ [STORAGE_KEY]: clean });
        saved = true;
      } catch (_) {}
    }
    if ((!saved || localArea !== syncArea) && localArea) {
      try {
        await localArea.set({ [STORAGE_KEY]: clean });
      } catch (_) {}
    }
    return clean;
  }

  async function saveKnownCourses(courses) {
    const localArea = getLocalArea();
    if (!localArea || !Array.isArray(courses) || courses.length === 0) return;

    const map = new Map();
    for (const c of courses) {
      if (!c || !c.id || map.has(c.id)) continue;
      map.set(c.id, {
        id: String(c.id),
        name: String(c.name || '').trim(),
        category: String(c.category || '').trim()
      });
    }

    try {
      await localArea.set({ [CATALOG_KEY]: Array.from(map.values()) });
    } catch (_) {}
  }

  async function loadKnownCourses() {
    const localArea = getLocalArea();
    if (!localArea) return [];
    try {
      const res = await localArea.get(CATALOG_KEY);
      return Array.isArray(res?.[CATALOG_KEY]) ? res[CATALOG_KEY] : [];
    } catch (_) {
      return [];
    }
  }

  function exportStateJson(state) {
    const clean = sanitizeState(state);
    return JSON.stringify(
      {
        version: 1,
        enabled: clean.enabled,
        hiddenCourses: clean.hiddenCourses,
        titleRules: clean.titleRules
      },
      null,
      2
    );
  }

  function importStateJson(jsonStr, currentState) {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Некорректный формат JSON');
    }
    const base = sanitizeState(currentState);
    const incoming = sanitizeState(parsed);
    return sanitizeState({
      enabled: parsed.enabled !== undefined ? incoming.enabled : base.enabled,
      showHiddenInline: base.showHiddenInline,
      hiddenCourses: { ...base.hiddenCourses, ...incoming.hiddenCourses },
      titleRules: dedupeRules([...base.titleRules, ...incoming.titleRules])
    });
  }

  return {
    STORAGE_KEY,
    CATALOG_KEY,
    createDefaultState,
    normalizeText,
    extractCourseId,
    sanitizeState,
    dedupeRules,
    parseRulesText,
    formatRulesText,
    matchCourseRule,
    isCourseHidden,
    loadState,
    saveState,
    saveKnownCourses,
    loadKnownCourses,
    exportStateJson,
    importStateJson
  };
});
