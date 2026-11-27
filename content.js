(function () {
  // В Firefox в контент-скриптах window !== globalThis, а shared.js пишет в globalThis.
  const Shared = globalThis.MPCHShared || window.MPCHShared;
  if (!Shared) return;

  // Prevent flicker before storage resolves.
  document.documentElement.classList.add('mpch-loading');
  const loadingTimeout = setTimeout(() => {
    document.documentElement.classList.remove('mpch-loading');
  }, 400);

  let state = Shared.createDefaultState();
  let searchQuery = '';
  let panelOpen = false;
  let isMutatingDom = false;
  let toastTimer = null;
  let rafScheduled = false;

  function clearLoading() {
    clearTimeout(loadingTimeout);
    document.documentElement.classList.remove('mpch-loading');
  }

  function extractLearningHistoryRow(tr) {
    const link = tr.querySelector('a[href*="course/view.php"]');
    if (!link) return null;
    const id = Shared.extractCourseId(link.getAttribute('href'));
    if (!id) return null;
    const span = link.querySelector('.has_before_icon');
    const name = (span ? span.textContent : link.textContent || '').replace(/\s+/g, ' ').trim();
    const category = (link.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    return { id, name, category, element: tr, link };
  }

  function extractCourseListItem(li) {
    const link = li.querySelector('a[href*="course/view.php"]');
    if (!link) return null;
    const id = Shared.extractCourseId(link.getAttribute('href'));
    if (!id) return null;
    const name = (link.textContent || '').replace(/\s+/g, ' ').trim();
    return { id, name, category: '', element: li, link };
  }

  function getHistorySection() {
    return document.querySelector('section.block_mylearninghistory');
  }

  function collectCourses() {
    const historyCourses = [];
    const dockCourses = [];

    const historySection = getHistorySection();
    if (historySection) {
      const rows = historySection.querySelectorAll('table tbody tr');
      rows.forEach((tr) => {
        const info = extractLearningHistoryRow(tr);
        if (info) historyCourses.push(info);
      });
    }

    const dockItems = document.querySelectorAll('section.block_course_list ul.unlist > li');
    dockItems.forEach((li) => {
      const info = extractCourseListItem(li);
      if (info) dockCourses.push(info);
    });

    return { historyCourses, dockCourses };
  }

  function showUndoToast(course) {
    let toast = document.getElementById('mpch-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mpch-toast';
      toast.className = 'mpch-toast';
      document.body.appendChild(toast);
    }

    toast.innerHTML = '';
    const text = document.createElement('span');
    text.className = 'mpch-toast-text';
    text.textContent = `Скрыт курс: «${course.name}»`;

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'mpch-toast-undo';
    undoBtn.textContent = 'Отменить';
    undoBtn.addEventListener('click', async () => {
      const next = Shared.sanitizeState(state);
      delete next.hiddenCourses[course.id];
      state = await Shared.saveState(next);
      toast.remove();
      applyAll();
    });

    toast.appendChild(text);
    toast.appendChild(undoBtn);

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.remove();
    }, 5000);
  }

  async function toggleManualCourse(course, shouldHide) {
    const next = Shared.sanitizeState(state);
    if (shouldHide) {
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
    applyAll();

    if (shouldHide && state.enabled && !state.showHiddenInline) {
      showUndoToast(course);
    }
  }

  function decorateHistoryRow(course, verdict) {
    const container = course.element.querySelector('.course_name_container');
    if (!container) return;

    let ctrl = container.querySelector('.mpch-row-control');
    if (!ctrl) {
      ctrl = document.createElement('div');
      ctrl.className = 'col-2 mpch-row-control';

      const label = document.createElement('label');
      label.className = 'mpch-check-label';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mpch-row-checkbox';

      const span = document.createElement('span');
      span.textContent = 'Скрыть';

      label.appendChild(cb);
      label.appendChild(span);
      ctrl.appendChild(label);

      const ruleTag = document.createElement('span');
      ruleTag.className = 'mpch-rule-tag';
      ruleTag.style.display = 'none';
      ruleTag.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        panelOpen = true;
        renderPanelContent();
        updateToolbarAndPanel();
      });
      ctrl.appendChild(ruleTag);

      cb.addEventListener('change', () => {
        toggleManualCourse(course, cb.checked);
      });

      container.appendChild(ctrl);
    }

    const label = ctrl.querySelector('.mpch-check-label');
    const cb = ctrl.querySelector('.mpch-row-checkbox');
    const textSpan = label.querySelector('span');
    const ruleTag = ctrl.querySelector('.mpch-rule-tag');

    const isManualHidden = Boolean(state.hiddenCourses[course.id]);
    cb.checked = isManualHidden;
    label.classList.toggle('mpch-checked', isManualHidden);
    textSpan.textContent = isManualHidden ? 'Скрыт' : 'Скрыть';
    label.title = isManualHidden
      ? 'Снять галочку, чтобы вернуть курс в список'
      : 'Скрыть этот курс из списка';

    if (verdict.reason === 'rule' && verdict.rule) {
      ruleTag.style.display = 'inline-flex';
      ruleTag.textContent = 'Правило';
      ruleTag.title = `Скрыт по правилу: «${verdict.rule}». Нажмите, чтобы открыть список правил.`;
    } else {
      ruleTag.style.display = 'none';
    }
  }

  function ensureToolbar(historySection) {
    const contentEl = historySection.querySelector('.card-text.content');
    if (!contentEl) return null;

    let toolbar = contentEl.querySelector('.mpch-toolbar');
    let panel = contentEl.querySelector('.mpch-panel');

    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.className = 'mpch-toolbar';
      toolbar.innerHTML = `
        <div class="mpch-toolbar-left">
          <div class="mpch-search-wrap">
            <input type="text" class="mpch-search-input" placeholder="Поиск по курсам..." aria-label="Поиск по курсам" />
            <button type="button" class="mpch-search-clear" title="Очистить поиск" aria-label="Очистить поиск">&times;</button>
          </div>
          <span class="mpch-stats"></span>
        </div>
        <div class="mpch-toolbar-right">
          <button type="button" class="mpch-btn mpch-btn-toggle-hidden"></button>
          <button type="button" class="mpch-btn mpch-btn-panel">Список и правила</button>
          <button type="button" class="mpch-btn mpch-btn-enable"></button>
        </div>
      `;

      panel = document.createElement('div');
      panel.className = 'mpch-panel';
      panel.innerHTML = `
        <div class="mpch-panel-grid">
          <div class="mpch-panel-section">
            <h6>Скрывать по названию</h6>
            <p class="mpch-hint">
              Каждая строка — слово или фраза из названия курса (регистр не важен).
              Для точного совпадения начните строку с <code>=</code>.
            </p>
            <div class="mpch-rule-add-row">
              <input type="text" class="mpch-input mpch-quick-rule-input" placeholder="Например: Анкетирование" />
              <button type="button" class="mpch-btn mpch-btn-primary mpch-quick-rule-add">Добавить</button>
            </div>
            <textarea class="mpch-textarea mpch-rules-textarea" placeholder="Анкетирование&#10;Входное тестирование&#10;Базовая грамматика"></textarea>
            <div class="mpch-panel-actions">
              <button type="button" class="mpch-btn mpch-btn-primary mpch-save-rules">Сохранить список</button>
              <span class="mpch-saved-flash" style="display:none;">Сохранено</span>
            </div>
          </div>
          <div class="mpch-panel-section">
            <h6>Скрытые галочкой (<span class="mpch-manual-count">0</span>)</h6>
            <p class="mpch-hint">
              Отмеченные вручную курсы скрываются по уникальному ID (одинаковые названия не перепутаются).
            </p>
            <div class="mpch-hidden-list"></div>
            <div class="mpch-panel-actions">
              <button type="button" class="mpch-btn mpch-unhide-all">Вернуть все</button>
              <button type="button" class="mpch-btn mpch-export-btn">Экспорт JSON</button>
              <button type="button" class="mpch-btn mpch-import-btn">Импорт JSON</button>
              <input type="file" class="mpch-import-file" accept=".json,application/json" style="display:none;" />
            </div>
          </div>
        </div>
      `;

      const tableResp = contentEl.querySelector('.table-responsive');
      if (tableResp) {
        contentEl.insertBefore(toolbar, tableResp);
        contentEl.insertBefore(panel, tableResp);
      } else {
        contentEl.prepend(panel);
        contentEl.prepend(toolbar);
      }

      // Wire events once
      const searchInput = toolbar.querySelector('.mpch-search-input');
      const searchClear = toolbar.querySelector('.mpch-search-clear');
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        searchClear.classList.toggle('mpch-visible', searchQuery.length > 0);
        applyVisibilityOnly();
      });
      searchClear.addEventListener('click', () => {
        searchQuery = '';
        searchInput.value = '';
        searchClear.classList.remove('mpch-visible');
        applyVisibilityOnly();
        searchInput.focus();
      });

      toolbar.querySelector('.mpch-btn-toggle-hidden').addEventListener('click', async () => {
        const next = Shared.sanitizeState(state);
        next.showHiddenInline = !next.showHiddenInline;
        state = await Shared.saveState(next);
        applyAll();
      });

      toolbar.querySelector('.mpch-btn-panel').addEventListener('click', () => {
        panelOpen = !panelOpen;
        if (panelOpen) renderPanelContent();
        updateToolbarAndPanel();
      });

      toolbar.querySelector('.mpch-btn-enable').addEventListener('click', async () => {
        const next = Shared.sanitizeState(state);
        next.enabled = !next.enabled;
        state = await Shared.saveState(next);
        applyAll();
      });

      const quickInput = panel.querySelector('.mpch-quick-rule-input');
      const quickAddBtn = panel.querySelector('.mpch-quick-rule-add');
      const rulesArea = panel.querySelector('.mpch-rules-textarea');
      const saveRulesBtn = panel.querySelector('.mpch-save-rules');
      const savedFlash = panel.querySelector('.mpch-saved-flash');

      function flashSaved() {
        savedFlash.style.display = 'inline';
        setTimeout(() => {
          savedFlash.style.display = 'none';
        }, 1800);
      }

      async function addQuickRule() {
        const val = quickInput.value.trim();
        if (!val) return;
        const next = Shared.sanitizeState(state);
        next.titleRules = Shared.dedupeRules([...next.titleRules, val]);
        state = await Shared.saveState(next);
        quickInput.value = '';
        renderPanelContent();
        applyAll();
        flashSaved();
      }

      quickAddBtn.addEventListener('click', addQuickRule);
      quickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addQuickRule();
        }
      });

      saveRulesBtn.addEventListener('click', async () => {
        const next = Shared.sanitizeState(state);
        next.titleRules = Shared.parseRulesText(rulesArea.value);
        state = await Shared.saveState(next);
        renderPanelContent();
        applyAll();
        flashSaved();
      });

      panel.querySelector('.mpch-unhide-all').addEventListener('click', async () => {
        const next = Shared.sanitizeState(state);
        next.hiddenCourses = {};
        state = await Shared.saveState(next);
        renderPanelContent();
        applyAll();
      });

      panel.querySelector('.mpch-export-btn').addEventListener('click', () => {
        const json = Shared.exportStateJson(state);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'sdo-hidden-courses.json';
        a.click();
        URL.revokeObjectURL(url);
      });

      const importInput = panel.querySelector('.mpch-import-file');
      panel.querySelector('.mpch-import-btn').addEventListener('click', () => {
        importInput.click();
      });
      importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          state = await Shared.saveState(Shared.importStateJson(text, state));
          renderPanelContent();
          applyAll();
          flashSaved();
        } catch (err) {
          alert('Не удалось импортировать файл: ' + (err?.message || err));
        } finally {
          importInput.value = '';
        }
      });
    }

    return { toolbar, panel };
  }

  function renderPanelContent() {
    const historySection = getHistorySection();
    if (!historySection) return;
    const panel = historySection.querySelector('.mpch-panel');
    if (!panel) return;

    const rulesArea = panel.querySelector('.mpch-rules-textarea');
    if (document.activeElement !== rulesArea) {
      rulesArea.value = Shared.formatRulesText(state.titleRules);
    }

    const entries = Object.values(state.hiddenCourses).sort((a, b) =>
      a.name.localeCompare(b.name, 'ru')
    );
    panel.querySelector('.mpch-manual-count').textContent = String(entries.length);

    const listEl = panel.querySelector('.mpch-hidden-list');
    listEl.innerHTML = '';

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mpch-empty-box';
      empty.textContent = 'Нет курсов, скрытых галочкой.';
      listEl.appendChild(empty);
      return;
    }

    for (const item of entries) {
      const row = document.createElement('div');
      row.className = 'mpch-hidden-item';

      const info = document.createElement('div');
      info.className = 'mpch-hidden-item-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'mpch-hidden-item-name';
      nameEl.textContent = item.name;
      nameEl.title = item.name;
      info.appendChild(nameEl);

      if (item.category) {
        const catEl = document.createElement('div');
        catEl.className = 'mpch-hidden-item-cat';
        catEl.textContent = item.category;
        catEl.title = item.category;
        info.appendChild(catEl);
      }

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'mpch-btn';
      restoreBtn.textContent = 'Вернуть';
      restoreBtn.addEventListener('click', async () => {
        const next = Shared.sanitizeState(state);
        delete next.hiddenCourses[item.id];
        state = await Shared.saveState(next);
        renderPanelContent();
        applyAll();
      });

      row.appendChild(info);
      row.appendChild(restoreBtn);
      listEl.appendChild(row);
    }
  }

  let lastStats = { total: 0, visible: 0, hidden: 0 };

  function updateToolbarAndPanel() {
    const historySection = getHistorySection();
    if (!historySection) return;
    const refs = ensureToolbar(historySection);
    if (!refs) return;

    const { toolbar, panel } = refs;
    const statsEl = toolbar.querySelector('.mpch-stats');
    statsEl.textContent =
      lastStats.hidden > 0
        ? `Показано: ${lastStats.visible} из ${lastStats.total} (скрыто: ${lastStats.hidden})`
        : `Курсов: ${lastStats.total}`;

    const toggleHiddenBtn = toolbar.querySelector('.mpch-btn-toggle-hidden');
    toggleHiddenBtn.textContent = state.showHiddenInline
      ? `Скрыть отмеченные (${lastStats.hidden})`
      : `Показать скрытые (${lastStats.hidden})`;
    toggleHiddenBtn.classList.toggle('mpch-btn-active', state.showHiddenInline);

    const panelBtn = toolbar.querySelector('.mpch-btn-panel');
    panelBtn.classList.toggle('mpch-btn-active', panelOpen);
    panel.classList.toggle('mpch-panel-open', panelOpen);

    const enableBtn = toolbar.querySelector('.mpch-btn-enable');
    enableBtn.textContent = state.enabled ? 'Фильтр: Вкл' : 'Фильтр: Выкл';
    enableBtn.classList.toggle('mpch-btn-muted', !state.enabled);

    // Empty table message when all courses are hidden or filtered out
    const tableResp = historySection.querySelector('.table-responsive');
    if (tableResp) {
      let emptyNote = historySection.querySelector('.mpch-empty-table-note');
      if (lastStats.total > 0 && lastStats.visible === 0) {
        if (!emptyNote) {
          emptyNote = document.createElement('div');
          emptyNote.className = 'mpch-empty-table-note';
          tableResp.insertAdjacentElement('afterend', emptyNote);
        }
        emptyNote.innerHTML = '';
        const msg = document.createElement('span');
        msg.textContent = searchQuery
          ? 'По вашему запросу ничего не найдено среди видимых курсов. '
          : 'Все курсы скрыты фильтром. ';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mpch-btn';
        btn.textContent = 'Показать скрытые';
        btn.addEventListener('click', async () => {
          const next = Shared.sanitizeState(state);
          next.showHiddenInline = true;
          state = await Shared.saveState(next);
          applyAll();
        });
        emptyNote.appendChild(msg);
        emptyNote.appendChild(btn);
      } else if (emptyNote) {
        emptyNote.remove();
      }
    }
  }

  function applyVisibilityOnly() {
    isMutatingDom = true;
    try {
      const { historyCourses, dockCourses } = collectCourses();
      const normSearch = Shared.normalizeText(searchQuery);

      let hiddenCount = 0;
      let visibleCount = 0;

      for (const course of historyCourses) {
        const verdict = Shared.isCourseHidden(course, state);
        const matchesSearch =
          !normSearch ||
          Shared.normalizeText(course.name).includes(normSearch) ||
          Shared.normalizeText(course.category).includes(normSearch);

        if (verdict.hidden) hiddenCount++;

        const shouldHideRow = verdict.hidden && !state.showHiddenInline;
        const shouldHideSearch = !matchesSearch;

        course.element.classList.toggle('mpch-row-hidden', shouldHideRow);
        course.element.classList.toggle('mpch-search-hidden', shouldHideSearch);
        course.element.classList.toggle(
          'mpch-row-dimmed',
          verdict.hidden && state.showHiddenInline
        );

        if (!shouldHideRow && !shouldHideSearch) {
          visibleCount++;
        }

        decorateHistoryRow(course, verdict);
      }

      for (const course of dockCourses) {
        const verdict = Shared.isCourseHidden(course, state);
        const shouldHideRow = verdict.hidden && !state.showHiddenInline;
        course.element.classList.toggle('mpch-row-hidden', shouldHideRow);
        course.element.classList.toggle(
          'mpch-row-dimmed',
          verdict.hidden && state.showHiddenInline
        );
      }

      lastStats = {
        total: historyCourses.length,
        visible: visibleCount,
        hidden: hiddenCount
      };

      updateToolbarAndPanel();
    } finally {
      isMutatingDom = false;
    }
  }

  function applyAll() {
    const { historyCourses, dockCourses } = collectCourses();
    if (historyCourses.length > 0) {
      Shared.saveKnownCourses(historyCourses);
    } else if (dockCourses.length > 0) {
      Shared.saveKnownCourses(dockCourses);
    }

    applyVisibilityOnly();
    if (panelOpen) {
      renderPanelContent();
    }
  }

  function scheduleApply() {
    if (rafScheduled || isMutatingDom) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      applyVisibilityOnly();
    });
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      if (isMutatingDom) return;
      for (const m of mutations) {
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          scheduleApply();
          return;
        }
      }
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function init() {
    state = await Shared.loadState();

    const onReady = () => {
      applyAll();
      clearLoading();
      startObserver();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else {
      onReady();
    }
  }

  const extApi =
    typeof browser !== 'undefined' && browser.storage
      ? browser
      : typeof chrome !== 'undefined'
        ? chrome
        : null;
  if (extApi && extApi.storage && extApi.storage.onChanged) {
    extApi.storage.onChanged.addListener((changes) => {
      if (changes[Shared.STORAGE_KEY]) {
        state = Shared.sanitizeState(changes[Shared.STORAGE_KEY].newValue);
        applyVisibilityOnly();
        if (panelOpen) renderPanelContent();
      }
    });
  }

  init();
})();
