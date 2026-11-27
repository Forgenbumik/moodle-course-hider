(async function () {
  const Shared = window.MPCHShared;
  if (!Shared) return;

  let state = await Shared.loadState();
  let knownCourses = await Shared.loadKnownCourses();

  const enabledToggle = document.getElementById('enabled-toggle');
  const summaryBadge = document.getElementById('summary-badge');
  const courseSearch = document.getElementById('course-search');
  const onlyHiddenToggle = document.getElementById('only-hidden-toggle');
  const coursesListEl = document.getElementById('courses-list');
  const quickRuleInput = document.getElementById('quick-rule-input');
  const quickRuleAdd = document.getElementById('quick-rule-add');
  const rulesTextarea = document.getElementById('rules-textarea');
  const saveRulesBtn = document.getElementById('save-rules-btn');
  const rulesStatus = document.getElementById('rules-status');
  const backupStatus = document.getElementById('backup-status');

  // Tabs
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${target}`);
      });
    });
  });

  function mergeCourseLists() {
    const byId = new Map();
    for (const c of knownCourses) {
      byId.set(c.id, c);
    }
    for (const c of Object.values(state.hiddenCourses)) {
      if (!byId.has(c.id)) {
        byId.set(c.id, c);
      }
    }
    return Array.from(byId.values());
  }

  function flashStatus(el, msg) {
    el.textContent = msg;
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, 2000);
  }

  function renderHeader() {
    enabledToggle.checked = state.enabled;
    const allCourses = mergeCourseLists();
    let hiddenCount = 0;
    for (const c of allCourses) {
      if (Shared.isCourseHidden(c, state).hidden) hiddenCount++;
    }
    const manualCount = Object.keys(state.hiddenCourses).length;
    const displayCount = allCourses.length > 0 ? hiddenCount : manualCount;
    summaryBadge.textContent = state.enabled
      ? `Скрыто: ${displayCount}`
      : 'Отключён';
  }

  function renderCourses() {
    const query = Shared.normalizeText(courseSearch.value);
    const onlyHidden = onlyHiddenToggle.checked;
    const all = mergeCourseLists();

    coursesListEl.innerHTML = '';

    if (all.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-msg';
      empty.textContent =
        'Список курсов появится после первого открытия страницы «Мои курсы» в СДО. Пока можно добавить названия во вкладке «По названию».';
      coursesListEl.appendChild(empty);
      return;
    }

    const filtered = all.filter((course) => {
      const verdict = Shared.isCourseHidden(course, { ...state, enabled: true });
      if (onlyHidden && !verdict.hidden) return false;
      if (!query) return true;
      return (
        Shared.normalizeText(course.name).includes(query) ||
        Shared.normalizeText(course.category).includes(query)
      );
    });

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-msg';
      empty.textContent = 'Подходящих курсов не найдено.';
      coursesListEl.appendChild(empty);
      return;
    }

    for (const course of filtered) {
      const label = document.createElement('label');
      label.className = 'course-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = Boolean(state.hiddenCourses[course.id]);
      cb.addEventListener('change', async () => {
        const next = Shared.sanitizeState(state);
        if (cb.checked) {
          next.hiddenCourses[course.id] = {
            id: course.id,
            name: course.name,
            category: course.category || '',
            addedAt: Date.now()
          };
        } else {
          delete next.hiddenCourses[course.id];
        }
        state = await Shared.saveState(next);
        renderHeader();
        if (onlyHidden) renderCourses();
      });

      const meta = document.createElement('div');
      meta.className = 'course-meta';

      const nameEl = document.createElement('div');
      nameEl.className = 'course-name';
      nameEl.textContent = course.name;
      meta.appendChild(nameEl);

      if (course.category) {
        const catEl = document.createElement('div');
        catEl.className = 'course-cat';
        catEl.textContent = course.category;
        catEl.title = course.category;
        meta.appendChild(catEl);
      }

      const ruleMatch = Shared.matchCourseRule(course.name, state.titleRules);
      if (ruleMatch) {
        const pill = document.createElement('span');
        pill.className = 'rule-pill';
        pill.textContent = `Правило: ${ruleMatch}`;
        meta.appendChild(pill);
      }

      label.appendChild(cb);
      label.appendChild(meta);
      coursesListEl.appendChild(label);
    }
  }

  function renderRules() {
    rulesTextarea.value = Shared.formatRulesText(state.titleRules);
  }

  enabledToggle.addEventListener('change', async () => {
    const next = Shared.sanitizeState(state);
    next.enabled = enabledToggle.checked;
    state = await Shared.saveState(next);
    renderHeader();
  });

  courseSearch.addEventListener('input', renderCourses);
  onlyHiddenToggle.addEventListener('change', renderCourses);

  async function addQuickRule() {
    const val = quickRuleInput.value.trim();
    if (!val) return;
    const next = Shared.sanitizeState(state);
    next.titleRules = Shared.dedupeRules([...next.titleRules, val]);
    state = await Shared.saveState(next);
    quickRuleInput.value = '';
    renderRules();
    renderHeader();
    renderCourses();
    flashStatus(rulesStatus, 'Правило добавлено');
  }

  quickRuleAdd.addEventListener('click', addQuickRule);
  quickRuleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addQuickRule();
    }
  });

  saveRulesBtn.addEventListener('click', async () => {
    const next = Shared.sanitizeState(state);
    next.titleRules = Shared.parseRulesText(rulesTextarea.value);
    state = await Shared.saveState(next);
    renderRules();
    renderHeader();
    renderCourses();
    flashStatus(rulesStatus, 'Список сохранён');
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    const json = Shared.exportStateJson(state);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sdo-hidden-courses.json';
    a.click();
    URL.revokeObjectURL(url);
    flashStatus(backupStatus, 'Файл скачан');
  });

  document.getElementById('copy-json-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(Shared.exportStateJson(state));
      flashStatus(backupStatus, 'JSON скопирован в буфер');
    } catch (_) {
      flashStatus(backupStatus, 'Не удалось скопировать');
    }
  });

  const importFileInput = document.getElementById('import-file');
  document.getElementById('import-btn').addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      state = await Shared.saveState(Shared.importStateJson(text, state));
      renderHeader();
      renderCourses();
      renderRules();
      flashStatus(backupStatus, 'Импорт выполнен');
    } catch (err) {
      flashStatus(backupStatus, 'Ошибка импорта: ' + (err?.message || err));
    } finally {
      importFileInput.value = '';
    }
  });

  document.getElementById('clear-all-btn').addEventListener('click', async () => {
    if (!confirm('Удалить все скрытые курсы и правила по названию?')) return;
    state = await Shared.saveState(Shared.createDefaultState());
    renderHeader();
    renderCourses();
    renderRules();
    flashStatus(backupStatus, 'Список очищен');
  });

  renderHeader();
  renderCourses();
  renderRules();
})();
