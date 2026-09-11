const TREE_ORIENTATION = Object.freeze({
  NORMAL: 'normal',
  FLIPPED_SOURCE: 'flipped-source',
});

// The item selected on first load when no #code is in the URL.
const DEFAULT_ITEM_CODE = normalizeCode('I09B');

const PLAYER_ITEM_ALLOWLIST = new Set([
  'Aeternalis Crystal (Arcane Mage Tier 4)',
  'Arrow of the Void (Ranger Tier 4)',
  "Belanor's Fractured Sword of Fury (Berserker Tier 4)",
  'Crown of the Blood King (Vampyr Tier 4)',
  'Emblem of Agdar (Werewolf Tier 4)',
  'Orb of Creation (Angel Tier 4)',
  'Skull of Fath (Warlock Tier 4)',
]);

// Runtime state is grouped by responsibility so future features can add data,
// indexes, or UI state without turning this object into another flat bag.
const state = {
  data: {
    items: [],
    craftedItems: [],
    enemies: [],
  },
  indexes: {
    byCode: new Map(),
    byName: new Map(),
    usedBy: new Map(),
    enemiesByCode: new Map(),
    enemiesByName: new Map(),
    shopsByName: new Map(),
    searchEntries: { crafting: [], items: [], enemies: [], shops: [], everything: [], 'everything-technical': [] },
  },
  ui: {
    selected: null,
    searchResults: [],
    activeResult: -1,
  },
  craftOwned: new Map(),
  nestedOwned: new Map(),
  summaryTab: 'materials',
  nestedExpanded: new Set(),
  summarySort: { mode: 'rarity', quantityOrder: 'desc', rarityOrder: 'desc' },
  summarySyncNested: false,
  summaryDeprioritizeCompleted: false,
  summaryDimCompleted: false,
  viewport: {
    scale: 1,
    x: 32,
    y: 32,
    drag: null,
  },
};

const elements = {
  picker: document.querySelector('#picker'), search: document.querySelector('#item-search'), searchMode: document.querySelector('#search-mode'),
  results: document.querySelector('#search-results'), dataNote: document.querySelector('#data-note'),
  selectedCard: document.querySelector('#selected-card'), metrics: document.querySelector('#metrics'),
  materialTotal: document.querySelector('#material-total'), materialsList: document.querySelector('#materials-list'),
  nestedCraftingList: document.querySelector('#nested-crafting-list'),
  summaryTitle: document.querySelector('#summary-title'),
  summaryTabMaterials: document.querySelector('#summary-tab-materials'),
  summaryTabNested: document.querySelector('#summary-tab-nested'),
  summarySettingsToggle: document.querySelector('#summary-settings-toggle'),
  summarySettingsPanel: document.querySelector('#summary-settings-panel'),
  summarySortMode: document.querySelector('#summary-sort-mode'),
  summaryQuantityOrder: document.querySelector('#summary-quantity-order'),
  summaryRarityOrder: document.querySelector('#summary-rarity-order'),
  summarySyncNested: document.querySelector('#summary-sync-nested'),
  summaryResetOwned: document.querySelector('#summary-reset-owned'),
  summaryDeprioritizeCompleted: document.querySelector('#summary-deprioritize-completed'),
  summaryDimCompleted: document.querySelector('#summary-dim-completed'),
  treeTitle: document.querySelector('#tree-title'), treePanel: document.querySelector('.tree-panel'), viewport: document.querySelector('#tree-viewport'),
  stage: document.querySelector('#tree-stage'), loading: document.querySelector('#loading-state'),
  zoomValue: document.querySelector('#zoom-value'), zoomIn: document.querySelector('#zoom-in'),
  zoomOut: document.querySelector('#zoom-out'), fit: document.querySelector('#fit-tree'),
  gestureHint: document.querySelector('#gesture-hint'),
  itemDetails: document.querySelector('#item-details'),
  inspector: document.querySelector('.inspector'),
  inspectorResizer: document.querySelector('#inspector-resizer'),
  detailsResizer: document.querySelector('#details-resizer'),
  toggleRecipeMap: document.querySelector('#toggle-recipe-map'),
  layoutSelect: document.querySelector('#layout-select'),
};

boot();

async function boot() {
  // JSON stays external: the UI can evolve independently of the source dataset.
  bindInteractions();
  try {
    const response = await fetch('data/items.json');
    if (!response.ok) throw new Error(`Map data returned ${response.status}`);
    const data = await response.json();
    validateDataSchema(data);
    state.data.items = Array.isArray(data.items) ? data.items : [];
    state.data.enemies = Array.isArray(data.enemies) ? data.enemies : [];
    buildIndexes();
    registerWebMcpTool();
    elements.dataNote.textContent = `${state.data.craftedItems.length} crafted items · ${cleanMapName(data.sourceMap)}`;
    elements.loading.hidden = true;

    const requestedCode = normalizeCode(location.hash.slice(1));
    const requested = state.indexes.byCode.get(requestedCode);
    const initial = requested?.recipe?.length && isPlayerFacing(requested)
      ? requested : state.indexes.byCode.get(DEFAULT_ITEM_CODE) || state.data.craftedItems[0];
    if (!initial) throw new Error('No crafted items were found in the map export.');
    selectItem(initial, { updateHash: !requestedCode });
  } catch (error) {
    console.error(error);
    showError('The crafting data could not be loaded. Make sure data/items.json is available with the site.');
  }
}

function validateDataSchema(data) {
  if (!data || typeof data !== 'object') throw new Error('Crafting data is not a JSON object.');
  if (Number(data.schemaVersion) !== 2) {
    throw new Error(`Unsupported crafting data schema version: ${data.schemaVersion ?? 'missing'}`);
  }
  if (!Array.isArray(data.items) || !Array.isArray(data.enemies)) {
    throw new Error('Crafting data is missing the required items or enemies arrays.');
  }
}

function bindInteractions() {
  if (elements.selectedCard) {
    elements.selectedCard.setAttribute('role', 'button');
    elements.selectedCard.setAttribute('tabindex', '0');
    elements.selectedCard.setAttribute('aria-label', 'Open selected item details');
    elements.selectedCard.addEventListener('click', () => {
      if (state.ui.selected) showItemDetails(state.ui.selected);
    });
    elements.selectedCard.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (state.ui.selected) showItemDetails(state.ui.selected);
      }
    });
  }

  if (elements.summaryTabMaterials && elements.summaryTabNested) {
    elements.summaryTabMaterials.addEventListener('click', () => {
      state.summaryTab = 'materials';
      applySummaryTab();
    });
    elements.summaryTabNested.addEventListener('click', () => {
      state.summaryTab = 'nested';
      applySummaryTab();
    });
  }
  bindSummarySettings();
  bindPanelResizers();
  bindRecipeMapToggle();
  bindWorkspaceLayout();
  elements.searchMode.addEventListener('change', () => {
    closeResults();
    elements.search.value = '';
    updateSearch('');
    elements.search.focus();
  });
  elements.search.addEventListener('focus', () => updateSearch(elements.search.value));
  elements.search.addEventListener('input', () => updateSearch(elements.search.value));
  elements.search.addEventListener('keydown', handleSearchKeys);
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== elements.search) {
      event.preventDefault(); elements.search.focus(); elements.search.select();
    }
    if (event.key === 'Escape') closeResults();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!elements.picker.contains(event.target)) closeResults();
  });
  window.addEventListener('hashchange', () => {
    const item = state.indexes.byCode.get(normalizeCode(location.hash.slice(1)));
    if (item?.recipe?.length && item.rawCode !== state.ui.selected?.rawCode) selectItem(item, { updateHash: false });
  });
  elements.zoomIn.addEventListener('click', () => zoomAt(1.18));
  elements.zoomOut.addEventListener('click', () => zoomAt(1 / 1.18));
  elements.fit.addEventListener('click', fitTree);
  elements.viewport.addEventListener('wheel', handleWheel, { passive: false });
  elements.viewport.addEventListener('pointerdown', startDrag);
  elements.viewport.addEventListener('pointermove', moveDrag);
  elements.viewport.addEventListener('pointerup', stopDrag);
  elements.viewport.addEventListener('pointercancel', stopDrag);
  elements.viewport.addEventListener('dragstart', (event) => event.preventDefault());
}

function getSearchMode() {
  return elements.searchMode?.value || 'crafting';
}

function getSearchEntries() {
  return state.indexes.searchEntries[getSearchMode()] || state.indexes.searchEntries.crafting;
}

function searchEntryScore(entry, needle) {
  return searchScore({ name: entry.name }, needle);
}

function updateSearch(query) {
  const needle = normalizeText(query);
  state.ui.searchResults = getSearchEntries()
    .map((entry) => ({ entry, score: searchEntryScore(entry, needle) }))
    .filter((result) => result.score < 99)
    .sort((left, right) => left.score - right.score || left.entry.name.localeCompare(right.entry.name))
    .slice(0, 12)
    .map((result) => result.entry);
  state.ui.activeResult = state.ui.searchResults.length ? 0 : -1;
  renderSearchResults();
  elements.results.hidden = false;
  elements.search.setAttribute('aria-expanded', 'true');
}

function renderSearchResults() {
  elements.results.replaceChildren();
  if (!state.ui.searchResults.length) {
    const empty = document.createElement('div');
    empty.className = 'no-results';
    empty.textContent = `No ${searchModeLabel(getSearchMode()).toLocaleLowerCase()} match that search.`;
    elements.results.append(empty);
    return;
  }

  state.ui.searchResults.forEach((entry, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `search-result${index === state.ui.activeResult ? ' active' : ''}`;
    button.id = `search-option-${index}`;
    button.role = 'option';
    button.setAttribute('aria-selected', String(index === state.ui.activeResult));
    button.append(createSearchResultIcon(entry));

    const copy = document.createElement('span');
    copy.className = 'result-copy';
    const name = document.createElement('strong');
    name.textContent = entry.name;
    const meta = document.createElement('small');
    meta.textContent = searchEntrySummary(entry);
    copy.append(name, meta);

    const count = document.createElement('span');
    count.className = 'result-count';
    count.textContent = searchEntryCount(entry);
    button.append(copy, count);
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => selectSearchEntry(entry));
    elements.results.append(button);
  });
  elements.search.setAttribute('aria-activedescendant', `search-option-${state.ui.activeResult}`);
}

function searchModeLabel(mode) {
  switch (mode) {
    case 'enemies': return 'Enemies';
    case 'shops': return 'Shops';
    case 'items': return 'Items';
    case 'everything': return 'Everything';
    case 'everything-technical': return 'Everything + technical';
    default: return 'Crafts';
  }
}

function createSearchResultIcon(entry) {
  if (entry.type === 'item') return createIcon(entry.entity, 'result-placeholder');
  const placeholder = document.createElement('span');
  placeholder.className = 'result-placeholder';
  placeholder.dataset.entityPlaceholder = entry.type === 'enemy' ? 'E' : 'S';
  placeholder.textContent = entry.type === 'enemy' ? 'E' : 'S';
  placeholder.setAttribute('aria-hidden', 'true');
  return placeholder;
}

function searchEntrySummary(entry) {
  if (entry.type === 'enemy') {
    return entry.entity.level != null ? `Level ${entry.entity.level}` : 'Enemy';
  }
  if (entry.type === 'shop') {
    const count = Array.isArray(entry.entity.items) ? entry.entity.items.length : 0;
    return `${count} inventory item${count === 1 ? '' : 's'}`;
  }
  return itemSummary(entry.entity);
}

function searchEntryCount(entry) {
  if (entry.type === 'enemy') {
    const count = Array.isArray(entry.entity.drops) ? entry.entity.drops.length : 0;
    return `${count} drop${count === 1 ? '' : 's'}`;
  }
  if (entry.type === 'shop') {
    return 'Shop';
  }
  return entry.entity.recipe?.length
    ? `${entry.entity.recipe.length} part${entry.entity.recipe.length === 1 ? '' : 's'}`
    : 'Item';
}

function selectSearchEntry(entry) {
  if (entry.type === 'enemy') {
    elements.search.value = entry.name;
    closeResults();
    showMonsterDetails(entry.name);
    return;
  }
  if (entry.type === 'shop') {
    elements.search.value = entry.name;
    closeResults();
    showShopDetails(entry.name);
    return;
  }
  selectItem(entry.entity);
}

function handleSearchKeys(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (elements.results.hidden) updateSearch(elements.search.value);
    if (!state.ui.searchResults.length) return;
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    state.ui.activeResult = (state.ui.activeResult + direction + state.ui.searchResults.length) % state.ui.searchResults.length;
    renderSearchResults();
    document.querySelector(`#search-option-${state.ui.activeResult}`)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && state.ui.activeResult >= 0) {
    event.preventDefault(); selectSearchEntry(state.ui.searchResults[state.ui.activeResult]);
  } else if (event.key === 'Escape') closeResults();
}

function closeResults() {
  elements.results.hidden = true;
  elements.search.setAttribute('aria-expanded', 'false');
  elements.search.removeAttribute('aria-activedescendant');
}

function selectItem(item, options = {}) {
  const nextCode = itemKey(item);
  const currentCode = itemKey(state.ui.selected);
  if (nextCode && nextCode !== currentCode) beginQuickViewRecipe(item);
  state.ui.selected = item;
  state.nestedExpanded.clear();
  elements.search.value = item.name;
  elements.treeTitle.textContent = item.name;
  closeResults();
  if (options.updateHash !== false) history.replaceState(null, '', `#${item.rawCode}`);
  renderSelectedCard(item); renderTree(item); renderMaterials(item); renderItemDetails(item);
}

function renderSelectedCard(item) {
  elements.selectedCard.replaceChildren();
  elements.selectedCard.append(createIcon(item, 'selected-placeholder'));
  const copy = document.createElement('div'); copy.className = 'selected-copy';
  const title = document.createElement('h2'); title.textContent = item.name;
  const meta = document.createElement('div'); meta.className = 'item-meta';
  [item.quality, item.slot, item.requiredLevel ? `Level ${item.requiredLevel}` : null].filter(Boolean).forEach((label) => {
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = label; meta.append(tag);
  });
  copy.append(title, meta); elements.selectedCard.append(copy);
  const stats = recipeStats(item);
  elements.metrics.replaceChildren(metric(stats.depth, 'Layers'), metric(stats.nodes, 'Tree items'), metric(stats.baseTypes, 'Base types'));
}

// Shared collapse/expand toggle for a node's already-rendered `<ul>` of children.
// `getChildList` is called lazily on click (the list may not exist yet, or may be
// owned by a caller-side closure) and toggles the CSS `.collapsed` class on it.
// `labels(expanded)` returns { title, ariaLabel } for the current state.
function createCollapseToggle({ hasChildren, getChildList, labels, noChildrenTitle, noChildrenAriaLabel }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'node-control node-control-toggle';
  button.disabled = !hasChildren;

  const applyLabel = (expanded) => {
    button.textContent = hasChildren ? (expanded ? '−' : '+') : '•';
    if (hasChildren) {
      const { title, ariaLabel } = labels(expanded);
      button.title = title;
      if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
    } else {
      button.title = noChildrenTitle;
      if (noChildrenAriaLabel) button.setAttribute('aria-label', noChildrenAriaLabel);
    }
  };
  applyLabel(true); // Children render expanded by default.

  if (hasChildren) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const childList = getChildList();
      if (!childList) return;
      childList.classList.toggle('collapsed');
      applyLabel(!childList.classList.contains('collapsed'));
    });
  }
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  return button;
}

function renderEntityTree(entityType, entity, children, options = {}) {
  // Source trees are visually inverted; renderBranch receives that fact explicitly.
  elements.stage.replaceChildren();
  const composite = document.createElement('div');
  composite.className = 'tree-composite entity-tree-composite';
  const tree = document.createElement('ul');
  tree.className = `recipe-tree entity-root-tree${entityType === 'enemy' ? ' enemy-drop-tree' : entityType === 'shop' ? ' shop-inventory-tree' : ''}`;
  const rootLi = document.createElement('li');
  const rootCard = document.createElement('div');
  rootCard.className = 'node-card root entity-root-card';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'node-main';
  main.append(createEntityPlaceholder(entityType, 'node-placeholder'));
  const name = document.createElement('span');
  name.className = 'node-name';
  name.textContent = entity?.name || options.name || 'Unknown';
  main.append(name);
  const meta = document.createElement('span');
  meta.className = 'node-meta';
  meta.textContent = options.meta || (entityType === 'enemy' ? 'Enemy drops' : 'Shop inventory');
  main.append(meta);
  main.addEventListener('click', (event) => {
    event.stopPropagation();
    if (entityType === 'enemy') showMonsterDetails(entity?.name || options.name);
    else if (entityType === 'shop') showShopDetails(entity.name);
  });
  main.addEventListener('pointerdown', (event) => event.stopPropagation());
  rootCard.append(main);
  rootLi.append(rootCard);
  const controls = document.createElement('div');
  controls.className = 'node-controls';

  let childList = null;
  const toggleButton = createCollapseToggle({
    hasChildren: Boolean(children.length),
    getChildList: () => childList,
    labels: (expanded) => ({
      title: `${expanded ? 'Collapse' : 'Expand'} ${entityType === 'enemy' ? 'drops' : 'inventory'}`,
    }),
    noChildrenTitle: 'No entries to collapse',
  });

  const rootButton = document.createElement('button');
  rootButton.type = 'button';
  rootButton.className = 'node-control node-control-root';
  rootButton.textContent = '↗';
  rootButton.title = 'Already the center of the tree';
  rootButton.setAttribute('aria-label', 'Already the center of the tree');
  rootButton.disabled = true;

  controls.append(toggleButton, rootButton);
  rootCard.append(controls);

  if (children.length) {
    childList = document.createElement('ul');
    children.forEach((item) => childList.append(renderBranch(item, {
        edgeQuantity: 1,
        totalQuantity: 1,
        path: new Set(),
        isRoot: false,
        orientation: TREE_ORIENTATION.FLIPPED_SOURCE,
        showContinuation: true,
        showRecipeChildren: false,
      })));
    rootLi.append(childList);
  }
  rootButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  tree.append(rootLi);
  composite.append(tree);
  elements.stage.append(composite);
  requestAnimationFrame(fitTree);
}

function findEnemyByName(name) {
  const key = String(name || '').trim().toLocaleLowerCase();
  return key ? (state.indexes.enemiesByName.get(key) || null) : null;
}

function showEnemyTree(monsterName) {
  const name = String(monsterName || '').trim();
  const enemy = findEnemyByName(name);
  if (!enemy) return;
  const drops = enemy.drops?.length
    ? enemy.drops.map((drop) => state.indexes.byName.get(String(drop.itemName || '').trim().toLocaleLowerCase())).filter(Boolean)
    : state.data.items.filter((item) => (item.monsterDrops || []).some((drop) => String(drop.monsterName || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase()));
  const unique = new Map();
  drops.forEach((item) => unique.set(normalizeCode(item.rawCode), item));
  const items = [...unique.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  elements.treeTitle.textContent = `${enemy.name} — Drops`;
  renderEntityTree('enemy', enemy, items, { meta: `${items.length} recorded drop${items.length === 1 ? '' : 's'}` });
}

function showShopTree(shopName) {
  const name = String(shopName || '').trim();
  const shop = state.indexes.shopsByName.get(name);
  if (!shop) return;
  const items = (shop.purchasableItems || []).slice();
  const unique = new Map();
  items.forEach((item) => unique.set(normalizeCode(item.rawCode), item));
  const inventory = [...unique.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  elements.treeTitle.textContent = `${name} — Inventory`;
  renderEntityTree('shop', shop, inventory, { meta: `${inventory.length} purchasable item${inventory.length === 1 ? '' : 's'}` });
}

function renderTree(item) {
  // Normal trees run from the selected item down into recipe ingredients.
  elements.stage.replaceChildren();
  const composite = document.createElement('div'); composite.className = 'tree-composite';
  const usages = recipesUsing(item);
  if (usages.length) {
    const label = document.createElement('p'); label.className = 'usage-label'; label.textContent = 'Crafts into';
    const usageTree = document.createElement('ul');
    usageTree.className = 'recipe-tree usage-tree';
    usageTree.setAttribute('aria-label', `Items crafted using ${item.name}`);
    usageTree.append(renderUsageAnchor(item));
    composite.append(label, usageTree);
  }
  const tree = document.createElement('ul');
  tree.className = `recipe-tree ingredient-tree${usages.length ? ' has-usages' : ''}`;
  tree.append(renderBranch(item, {
    edgeQuantity: 1,
    totalQuantity: 1,
    path: new Set(),
    isRoot: true,
    orientation: TREE_ORIENTATION.NORMAL,
    showContinuation: true,
  }));
  composite.append(tree); elements.stage.append(composite);
  requestAnimationFrame(fitTree);
}

function createNodeMain(item, fallbackName = 'Unknown item') {
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'node-main';
  main.append(createIcon(item, 'node-placeholder'));

  const name = document.createElement('span');
  name.className = 'node-name';
  name.textContent = item.name || fallbackName;
  const meta = document.createElement('span');
  meta.className = 'node-meta';
  main.append(name, meta);

  main.addEventListener('click', (event) => {
    event.stopPropagation();
    showItemDetails(item);
  });
  main.addEventListener('pointerdown', (event) => event.stopPropagation());
  return { main, meta };
}

function createNodeControls(item, listItem, children) {
  const controls = document.createElement('div');
  controls.className = 'node-controls';

  const toggleButton = createCollapseToggle({
    hasChildren: Boolean(children.length),
    getChildList: () => listItem.querySelector(':scope > ul'),
    labels: (expanded) => ({
      title: `${expanded ? 'Collapse' : 'Expand'} this recipe branch`,
      ariaLabel: `${expanded ? 'Collapse' : 'Expand'} ${item.name || 'branch'}`,
    }),
    noChildrenTitle: 'No branch to collapse',
    noChildrenAriaLabel: `No recipe branch for ${item.name || 'item'}`,
  });

  const rootButton = document.createElement('button');
  rootButton.type = 'button';
  rootButton.className = 'node-control node-control-root';
  rootButton.textContent = '↗';
  rootButton.title = `Make ${item.name || 'item'} the center of the tree`;
  rootButton.setAttribute('aria-label', `Make ${item.name || 'item'} the center of the tree`);

  rootButton.addEventListener('click', (event) => {
    event.stopPropagation();
    selectItem(item);
    scrollTreeIntoViewOnMobile();
  });
  rootButton.addEventListener('pointerdown', (event) => event.stopPropagation());

  controls.append(toggleButton, rootButton);
  return controls;
}

function createContinuation(item, orientation) {
  const count = craftingUsageCount(item);
  const continuation = document.createElement('button');
  continuation.type = 'button';
  continuation.className = `node-continuation${orientation === TREE_ORIENTATION.FLIPPED_SOURCE ? ' entity-continuation' : ''}`;
  continuation.title = `${count} further craft${count === 1 ? '' : 's'} use ${item.name || 'this item'}`;
  continuation.setAttribute('aria-label', `${count} further craft${count === 1 ? '' : 's'} use ${item.name || 'this item'}`);
  continuation.innerHTML = '<span class="continuation-arrow" aria-hidden="true">↑</span><span class="continuation-dots" aria-hidden="true">•••</span>';
  continuation.addEventListener('click', (event) => {
    event.stopPropagation();
    showItemDetails(item);
  });
  continuation.addEventListener('pointerdown', (event) => event.stopPropagation());
  return continuation;
}

function renderUsageAnchor(item) {
  const listItem = document.createElement('li');
  const children = recipesUsing(item);
  if (children.length) {
    const childList = document.createElement('ul');
    children.forEach(({ item: product, quantity }) => {
      childList.append(renderUsageBranch(product, quantity));
    });
    listItem.append(childList);
  }
  return listItem;
}

function renderUsageBranch(item, edgeQuantity) {
  const listItem = document.createElement('li');
  const card = document.createElement('div');
  card.className = 'node-card';
  card.dataset.rawCode = normalizeCode(item.rawCode);

  const { main, meta } = createNodeMain(item, 'Unknown crafted item');
  meta.textContent = item.quality || 'Crafted item';
  card.append(main);

  if (edgeQuantity > 1) {
    const quantity = document.createElement('span');
    quantity.className = 'quantity-badge';
    quantity.textContent = `×${edgeQuantity}`;
    card.append(quantity);
  }

  card.append(createNodeControls(item, listItem, []));
  listItem.append(card);

  // Usage nodes are the "Crafts into" side of the tree.
  if (hasCraftingUsages(item)) {
    const continuation = createContinuation(item, TREE_ORIENTATION.NORMAL);
    continuation.classList.add('usage-continuation');
    listItem.append(continuation);
  }

  return listItem;
}

function renderBranch(item, context = {}) {
  // Keep tree orientation/context explicit: DOM order differs for flipped source trees.
  const {
    edgeQuantity = 1,
    totalQuantity = 1,
    path = new Set(),
    isRoot = false,
    orientation = TREE_ORIENTATION.NORMAL,
    showContinuation = false,
    showRecipeChildren = true,
  } = context;
  const listItem = document.createElement('li');
  const code = normalizeCode(item.rawCode);
  // `path` is branch-local, so shared ingredients can repeat while real cycles stop.
  const circular = path.has(code);
  const children = circular || !showRecipeChildren ? [] : recipeChildren(item);
  const card = document.createElement('div');
  card.className = `node-card${children.length ? ' craftable' : ''}${isRoot ? ' root' : ''}${circular ? ' cycle' : ''}`;
  card.dataset.rawCode = normalizeCode(item.rawCode);

  const { main, meta } = createNodeMain(item, 'Unknown ingredient');
  meta.textContent = circular ? 'Circular reference' : children.length
    ? `${children.length} ingredient${children.length === 1 ? '' : 's'}${totalQuantity > edgeQuantity ? ` · ${totalQuantity} total` : ''}`
    : `${item.quality || 'Base material'}${totalQuantity > 1 ? ` · ${totalQuantity} total` : ''}`;
  card.append(main);

  if (!isRoot && edgeQuantity > 1) {
    const quantity = document.createElement('span');
    quantity.className = 'quantity-badge';
    quantity.textContent = `×${edgeQuantity}`;
    card.append(quantity);
  }

  card.append(createNodeControls(item, listItem, children));

  const continuation = showContinuation && hasCraftingUsages(item)
    ? createContinuation(item, orientation)
    : null;

  // The marker is placed according to the tree's declared orientation.
  // This is deliberately centralized so normal and flipped trees cannot drift
  // apart again when the renderer is changed.
  if (continuation && orientation === TREE_ORIENTATION.NORMAL) {
    listItem.append(continuation);
  }

  listItem.append(card);

  if (continuation && orientation === TREE_ORIENTATION.FLIPPED_SOURCE) {
    listItem.append(continuation);
  }

  if (children.length) {
    const childList = document.createElement('ul');
    const nextPath = new Set(path);
    nextPath.add(code);
    children.forEach(({ item: ingredient, quantity }) => {
      childList.append(renderBranch(ingredient, {
        edgeQuantity: quantity,
        totalQuantity: totalQuantity * quantity,
        path: nextPath,
        isRoot: false,
        orientation,
        // Normal item trees only show the marker on the central item.
        // Flipped source trees show it on every visible item branch.
        showContinuation: orientation === TREE_ORIENTATION.FLIPPED_SOURCE,
      }));
    });
    listItem.append(childList);
  }
  return listItem;
}

function showItemDetails(item) {
  if (!item || !elements.itemDetails) return;

  // Highlight the item that is currently being inspected.
  document.querySelectorAll('.node-card.details-selected').forEach((node) => {
    node.classList.remove('details-selected');
  });
  document.querySelectorAll('.node-card').forEach((node) => {
    if (node.dataset.rawCode === normalizeCode(item.rawCode)) {
      node.classList.add('details-selected');
    }
  });

  renderItemDetails(item);
}

function escapeHtml(value) {
  return cleanGameText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildIndexes() {
  state.indexes.byCode = new Map(
    state.data.items
      .map((item) => [normalizeCode(item.rawCode), item])
      .filter(([code]) => code)
  );
  state.indexes.byName = buildNameIndex(state.data.items);
  state.indexes.enemiesByCode = new Map(
    state.data.enemies
      .map((enemy) => [normalizeCode(enemy.rawCode), enemy])
      .filter(([code]) => code)
  );
  state.indexes.enemiesByName = buildNameIndex(state.data.enemies);
  state.indexes.shopsByName = buildShopIndex(state.data.items);
  state.indexes.usedBy = buildUsedByIndex();

  state.data.craftedItems = state.data.items
    .filter((item) => item.recipe?.length && isPlayerFacing(item))
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));

  state.indexes.searchEntries = buildSearchEntries();
}

function buildSearchEntries() {
  const toItemEntries = (items) => items
    .filter((item) => String(item?.name || '').trim())
    .map((item) => ({ type: 'item', entity: item, name: item.name }));
  const enemies = state.data.enemies
    .filter((enemy) => String(enemy?.name || '').trim())
    .map((enemy) => ({ type: 'enemy', entity: enemy, name: enemy.name }));
  const shops = [...state.indexes.shopsByName.values()]
    .filter((shop) => shop.purchasableItems?.length)
    .map((shop) => ({ type: 'shop', entity: shop, name: shop.name }));
  const playerItems = state.data.items.filter(isPlayerFacing);
  const allItems = state.data.items;

  // Everything is the player-facing union of items, enemies and usable shops.
  // Everything + technical deliberately exposes the raw item export as well.
  const dedupe = (entries) => {
    const seen = new Set();
    return entries.filter((entry) => {
      const key = `${entry.type}:${normalizeText(entry.name)}`;
      if (!entry.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    crafting: toItemEntries(state.data.craftedItems),
    items: toItemEntries(playerItems),
    enemies,
    shops,
    everything: dedupe([
      ...toItemEntries(playerItems),
      ...enemies,
      ...shops,
    ]),
    'everything-technical': dedupe([
      ...toItemEntries(allItems),
      ...enemies,
      ...shops,
    ]),
  };
}

function buildNameIndex(items) {
  const index = new Map();
  for (const item of items || []) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (!index.has(key)) index.set(key, item);
  }
  return index;
}

function isActualShopPurchase(item) {
  if (!item) return false;

  const name = String(item.name || '').trim();
  const rawCode = String(item.rawCode || '').trim();
  const rawName = String(item.rawName || '').trim();
  const purchaseTooltip = String(item.purchaseTooltip || '').trim();
  const tooltip = String(item.rawFields?.utip || '').trim();
  const classType = String(item.rawFields?.icla || '').trim().toLocaleLowerCase();

  // Broken/unresolved export records such as I00O are not useful as a
  // player-facing purchase even if Warcraft marks them Purchasable.
  if (!name || (name === rawCode && !rawName)) return false;

  // Navigation/category records are not goods.
  if (/\(Item\)$/i.test(name) || /^Return\s*\(/i.test(name)) return false;

  // The strongest signal in the export is an explicit Purchase tooltip.
  if (/^Purchase(?:\s|$)/i.test(purchaseTooltip)) return true;
  if (/^Purchase(?:\s|$)/i.test(tooltip)) return true;

  // Some shop goods carry Purchasable without the literal Purchase prefix.
  if (classType === 'purchasable') return true;

  return false;
}

function buildShopIndex(items = []) {
  const index = new Map();

  for (const item of items) {
    for (const shop of item.shops || []) {
      const name = String(shop.shopName || '').trim();
      if (!name) continue;

      if (!index.has(name)) {
        index.set(name, {
          name,
          items: [],
          purchasableItems: [],
          itemCodes: new Set(),
          categories: new Set(),
        });
      }

      const entry = index.get(name);
      const code = normalizeCode(item.rawCode);
      if (code && !entry.itemCodes.has(code)) {
        entry.itemCodes.add(code);
        entry.items.push(item);
      }
      if (isActualShopPurchase(item) && code) {
        if (!entry.purchasableItems.some((candidate) =>
          normalizeCode(candidate.rawCode) === code
        )) {
          entry.purchasableItems.push(item);
        }
        if (shop.categoryName) {
          entry.categories.add(String(shop.categoryName));
        }
      }
    }
  }

  for (const entry of index.values()) {
    entry.items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    entry.purchasableItems.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    entry.categories = [...entry.categories].sort((a, b) => a.localeCompare(b));
    delete entry.itemCodes;
  }

  return index;
}

function findItemByName(name) {
  const key = String(name || '').trim().toLocaleLowerCase();
  return key ? state.indexes.byName.get(key) || null : null;
}

function scrollTreeIntoViewOnMobile() {
  if (elements.treePanel && window.matchMedia('(max-width: 880px)').matches) {
    elements.treePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function formatNumber(value) {
  return value == null
    ? '—'
    : Number.isFinite(Number(value))
      ? Number(value).toLocaleString()
      : String(value);
}

function formatRange(minimum, maximum) {
  if (minimum == null && maximum == null) return '—';
  return `${formatNumber(minimum)}–${formatNumber(maximum)}`;
}

function formatDropChance(chancePerThousand) {
  const chance = Number(chancePerThousand);
  return Number.isFinite(chance)
    ? `${chance / 10}% drop`
    : 'Drop chance unknown';
}

function showShopDetails(shopName) {
  if (!shopName || !elements.itemDetails) return;

  document.querySelectorAll('.node-card.details-selected').forEach((node) => {
    node.classList.remove('details-selected');
  });

  const name = String(shopName).trim();
  const shop = state.indexes.shopsByName.get(name);
  const items = (shop?.purchasableItems || []).slice();

  const categoryGroups = new Map();
  for (const item of items) {
    const itemShops = (item.shops || []).filter(
      (entry) => String(entry.shopName || '').trim() === name
    );
    const categories = itemShops.map((entry) => String(entry.categoryName || '').trim()).filter(Boolean);
    const keys = categories.length ? categories : ['Uncategorized'];

    for (const category of keys) {
      if (!categoryGroups.has(category)) categoryGroups.set(category, []);
      if (!categoryGroups.get(category).some((candidate) =>
        normalizeCode(candidate.rawCode) === normalizeCode(item.rawCode)
      )) {
        categoryGroups.get(category).push(item);
      }
    }
  }

  const groups = [...categoryGroups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, categoryItems]) => [
      category,
      categoryItems.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    ]);

  const categoryCount = groups.length;

  elements.itemDetails.innerHTML = `
    <div class="shop-detail-header">
      <div class="shop-detail-icon" data-entity-placeholder="S" aria-hidden="true">S</div>
      <div class="details-item-heading">
        <p class="eyebrow">Shop / NPC</p>
        <h3>${escapeHtml(name)}</h3>
        <div class="details-tags">
          <span class="tag">${items.length} ${items.length === 1 ? 'item' : 'items'}</span>
          <span class="tag">${categoryCount} ${categoryCount === 1 ? 'category' : 'categories'}</span>
        </div>
        <button type="button" class="details-tree-button" data-action="shop-tree">Show inventory tree</button>
      </div>
    </div>

    <section class="details-section">
      <h4>Inventory</h4>
      ${groups.length ? groups.map(([category, categoryItems]) => `
        <div class="shop-category">
          <div class="shop-category-heading">
            <strong>${escapeHtml(category)}</strong>
            <span>${categoryItems.length}</span>
          </div>
          <div class="entity-list shop-inventory-list">
            ${categoryItems.map((item) => {
              const price = Number(item.rawFields?.igol);
              const purchase = String(item.purchaseTooltip || '').trim();
              const priceLabel = Number.isFinite(price) ? `${price.toLocaleString()} Gold` : 'Price not recorded';
              const sub = purchase && purchase !== `Purchase ${item.name}`
                ? purchase
                : (item.requiredLevel != null ? `Required level ${item.requiredLevel}` : priceLabel);
              return `
                <button type="button" class="entity-row shop-inventory-row" data-raw-code="${escapeHtml(normalizeCode(item.rawCode))}">
                  ${createIconMarkup(item, 'entity-row-icon')}
                  <span class="entity-row-copy">
                    <strong>${escapeHtml(item.name || item.rawCode || 'Unknown item')}</strong>
                    <small>${escapeHtml(sub)}</small>
                  </span>
                  <span class="shop-price">${escapeHtml(priceLabel)}</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      `).join('') : '<div class="details-empty">No purchasable inventory was recorded for this shop.</div>'}
    </section>
  `;

  bindItemIconFallbacks(elements.itemDetails);

  elements.itemDetails.querySelector('[data-action="shop-tree"]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    showShopTree(name);
    scrollTreeIntoViewOnMobile();
  });

  elements.itemDetails.querySelectorAll('.shop-inventory-row[data-raw-code]').forEach((row) => {
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      const item = state.indexes.byCode.get(normalizeCode(row.dataset.rawCode));
      if (item) showItemDetails(item);
    });
  });
}

function showMonsterDetails(monsterName) {
  if (!monsterName || !elements.itemDetails) return;

  document.querySelectorAll('.node-card.details-selected').forEach((node) => node.classList.remove('details-selected'));

  const enemy = findEnemyByName(monsterName);
  const drops = enemy?.drops?.length
    ? enemy.drops.map((drop) => ({
        item: findItemByName(drop.itemName),
        itemName: drop.itemName,
        chance: drop.chancePerThousand,
        difficulty: drop.difficultyRequirement
      }))
    : state.data.items.flatMap((item) => (item.monsterDrops || [])
        .filter((drop) => String(drop.monsterName || '').trim().toLocaleLowerCase() === String(monsterName).trim().toLocaleLowerCase())
        .map((drop) => ({item, itemName:item.name, chance:drop.chancePerThousand, difficulty:drop.difficultyRequirement})));

  const unique = new Map();
  for (const drop of drops) {
    const key = normalizeCode(drop.item?.rawCode) || `name:${String(drop.itemName || '').toLocaleLowerCase()}`;
    if (!unique.has(key)) unique.set(key, drop);
  }
  const rows = [...unique.values()].sort((a, b) =>
    String(a.item?.name || a.itemName || '').localeCompare(String(b.item?.name || b.itemName || ''))
  );

  elements.itemDetails.innerHTML=`
    <div class="enemy-detail-header">
      <div class="enemy-detail-icon enemy-icon-placeholder" data-entity-placeholder="E" aria-hidden="true">E</div>
      <div class="details-item-heading">
        <p class="eyebrow">Enemy</p>
        <h3>${escapeHtml(enemy?.name||monsterName)}</h3>
        <div class="details-tags">
          ${enemy?.level!=null?`<span class="tag">Level ${formatNumber(enemy.level)}</span>`:''}
          ${enemy?.armor!=null?`<span class="tag">Armor ${formatNumber(enemy.armor)}</span>`:''}
          ${enemy?.movementSpeed!=null?`<span class="tag">Move ${formatNumber(enemy.movementSpeed)}</span>`:''}
        </div>
        <button type="button" class="details-tree-button" data-action="enemy-tree">Show drops tree</button>
      </div>
    </div>
    <section class="details-section">
      <h4>Characteristics</h4>
      ${enemy?`
      <div class="enemy-stat-grid">
        <div class="enemy-stat"><span>Health</span><strong>${formatNumber(enemy.maximumHealth)}</strong></div>
        <div class="enemy-stat"><span>Mana</span><strong>${formatNumber(enemy.maximumMana)}</strong></div>
        <div class="enemy-stat"><span>Armor</span><strong>${formatNumber(enemy.armor)}</strong></div>
        <div class="enemy-stat"><span>Movement speed</span><strong>${formatNumber(enemy.movementSpeed)}</strong></div>
        <div class="enemy-stat"><span>Damage</span><strong>${formatRange(enemy.minimumDamage, enemy.maximumDamage)}</strong></div>
        <div class="enemy-stat"><span>Attack cooldown</span><strong>${enemy.attackCooldown==null?'—':`${formatNumber(enemy.attackCooldown)} s`}</strong></div>
        <div class="enemy-stat"><span>Gold</span><strong>${formatRange(enemy.minimumGold, enemy.maximumGold)}</strong></div>
        <div class="enemy-stat"><span>Respawn</span><strong>${enemy.respawnSeconds==null?'—':`${formatNumber(enemy.respawnSeconds)} s`}</strong></div>
      </div>`:'<div class="details-empty">No dedicated enemy record was found in this export.</div>'}
    </section>
    ${enemy ? `
    <section class="details-section enemy-reward-section">
      <h4>Experience</h4>
      <div class="enemy-reward-card">
        <div class="enemy-reward-main">
          <span class="enemy-reward-label">Experience</span>
          <strong>${formatRange(enemy.minimumExperience, enemy.maximumExperience)} XP</strong>
        </div>
        <div class="enemy-reward-sub">
          <span>Maximum level from experience</span>
          <strong>${formatNumber(enemy.maximumLevelFromExperience)}</strong>
        </div>
      </div>
    </section>` : ''}
    <section class="details-section">
      <h4>Drops <span class="section-count">${rows.length}</span></h4>
      ${rows.length?`<div class="entity-list enemy-drop-list">${rows.map(({item,itemName,chance,difficulty})=>item?`
        <button type="button" class="entity-row enemy-drop-row" data-raw-code="${escapeHtml(normalizeCode(item.rawCode))}">
          ${createIconMarkup(item,'entity-row-icon')}
          <span class="entity-row-copy"><strong>${escapeHtml(item.name)}</strong><small>${formatDropChance(chance)}${difficulty==null?'':` · difficulty ${escapeHtml(difficulty)}`}</small></span>
        </button>`:`
        <div class="entity-row enemy-drop-row unresolved">
          <span class="details-placeholder entity-row-icon">I</span>
          <span class="entity-row-copy"><strong>${escapeHtml(itemName||'Unknown item')}</strong><small>${formatDropChance(chance)}</small></span>
        </div>`).join('')}</div>`:'<div class="details-empty">No recorded drops.</div>'}
    </section>`;

  bindItemIconFallbacks(elements.itemDetails);

  elements.itemDetails.querySelector('[data-action="enemy-tree"]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    showEnemyTree(enemy?.name || monsterName);
    scrollTreeIntoViewOnMobile();
  });

  elements.itemDetails.querySelectorAll('.enemy-drop-row[data-raw-code]').forEach(row=>{
    row.addEventListener('click',e=>{
      e.stopPropagation();
      const item=state.indexes.byCode.get(normalizeCode(row.dataset.rawCode));
      if(item) showItemDetails(item);
    });
  });
}

function bindItemIconFallbacks(container) {
  if (!container) return;
  container.querySelectorAll('img[data-item-placeholder]').forEach((image) => {
    const replaceWithPlaceholder = () => {
      const placeholder = document.createElement('span');
      placeholder.className = `details-placeholder ${image.className}`.trim();
      placeholder.dataset.entityPlaceholder = image.dataset.itemPlaceholder || 'I';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.textContent = image.dataset.itemPlaceholder || 'I';
      image.replaceWith(placeholder);
    };

    image.addEventListener('error', replaceWithPlaceholder, { once: true });
    if (image.complete && image.naturalWidth === 0) replaceWithPlaceholder();
  });
}

function createIconMarkup(item,className=''){
  const classes = `details-placeholder ${escapeHtml(className)}`.trim();
  if (!item?.iconFile) {
    return `<span class="${classes}" data-entity-placeholder="I" aria-hidden="true">I</span>`;
  }
  return `<img src="${escapeHtml(item.iconFile)}" alt="" class="${escapeHtml(className)}" loading="lazy" data-item-placeholder="I">`;
}

function renderItemDetails(item) {
  if (!elements.itemDetails) return;
  elements.itemDetails.replaceChildren();

  const header = document.createElement('div');
  header.className = 'details-item-header';
  header.append(createIcon(item, 'details-icon'));

  const heading = document.createElement('div');
  heading.className = 'details-item-heading';

  const title = document.createElement('h3');
  title.textContent = item.name || 'Unknown item';
  heading.append(title);

  const meta = document.createElement('div');
  meta.className = 'details-tags';
  [
    item.quality,
    item.slot,
    item.requiredLevel != null ? `Level ${item.requiredLevel}` : null,
    item.allowedClasses?.length ? item.allowedClasses.join(', ') : null,
  ].filter(Boolean).forEach((value) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = value;
    meta.append(tag);
  });
  heading.append(meta);

  const treeButton = document.createElement('button');
  treeButton.type = 'button';
  treeButton.className = 'details-tree-button';
  treeButton.textContent = 'Show in tree';
  treeButton.title = `Show the crafting tree for ${item.name || 'this item'}`;
  treeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    selectItem(item);
    scrollTreeIntoViewOnMobile();
  });
  heading.append(treeButton);

  header.append(heading);
  elements.itemDetails.append(header);

  const tooltip = String(item.plainExtendedTooltip || '').trim();
  const paragraphs = tooltip.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const firstParagraph = paragraphs[0] || String(item.description || '').trim();

  if (firstParagraph) {
    const section = detailSection('Description');
    const text = document.createElement('p');
    text.className = 'details-description';
    text.textContent = firstParagraph;
    section.append(text);
    elements.itemDetails.append(section);
  }

  const provides = extractTooltipSection(tooltip, 'Provides:');
  if (provides.length) {
    const section = detailSection('Characteristics');
    const list = document.createElement('ul');
    list.className = 'details-stat-list';
    provides.forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line.replace(/^\s+/, '');
      list.append(li);
    });
    section.append(list);
    elements.itemDetails.append(section);
  }

  const effects = tooltipSectionsExcept(tooltip, new Set(['Provides:', 'Recipe:', 'Quality:', 'Slot:', 'Type:', 'Required Level:', 'Available Classes:', 'Recipe ID:']));
  if (effects.length) {
    const section = detailSection('Additional details');
    const pre = document.createElement('div');
    pre.className = 'details-text';
    pre.textContent = effects.join('\n');
    section.append(pre);
    elements.itemDetails.append(section);
  }

  if (item.recipe?.length) {
    const section = detailSection('Recipe');
    const list = document.createElement('div');
    list.className = 'entity-list details-recipe-list';

    item.recipe.forEach((ingredient) => {
      const target = state.indexes.byCode.get(normalizeCode(ingredient.rawCode));

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'entity-row recipe-entity-row';
      row.dataset.entityType = 'item';
      row.dataset.rawCode = normalizeCode(ingredient.rawCode);

      if (target) {
        row.append(createIcon(target, 'entity-row-icon'));
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'details-placeholder entity-row-icon';
        placeholder.textContent = 'I';
        row.append(placeholder);
      }

      const copy = document.createElement('span');
      copy.className = 'entity-row-copy';

      const name = document.createElement('strong');
      name.textContent = target?.name || ingredient.name || ingredient.rawCode || 'Unknown ingredient';
      copy.append(name);

      const meta = document.createElement('small');
      const quantity = Number(ingredient.quantity);
      meta.textContent = Number.isFinite(quantity) && quantity > 1
        ? `Quantity ×${quantity}`
        : 'Required ingredient';
      copy.append(meta);

      row.append(copy);

      row.addEventListener('click', (event) => {
        event.stopPropagation();
        if (target) showItemDetails(target);
      });

      list.append(row);
    });

    section.append(list);
    elements.itemDetails.append(section);
  }

  const miningSource = getWorldMiningSource(item);
  if (miningSource) {
    const section = detailSection('Sources');
    const list = document.createElement('div');
    list.className = 'entity-list details-source-list';

    const miningRow = document.createElement('div');
    miningRow.className = 'entity-row world-mining-row';

    const icon = createEntityPlaceholder('unknown', 'entity-row-icon');
    miningRow.append(icon);

    const copy = document.createElement('span');
    copy.className = 'entity-row-copy';

    const name = document.createElement('strong');
    name.textContent = cleanGameText(miningSource.label);
    copy.append(name);

    const description = document.createElement('small');
    description.textContent = cleanGameText(miningSource.description);
    copy.append(description);

    miningRow.append(copy);
    list.append(miningRow);

    if (miningSource.prospect) {
      const prospectRow = document.createElement('button');
      prospectRow.type = 'button';
      prospectRow.className = 'entity-row prospect-entity-row';
      prospectRow.append(createIcon(miningSource.prospect, 'entity-row-icon'));

      const prospectCopy = document.createElement('span');
      prospectCopy.className = 'entity-row-copy';

      const prospectName = document.createElement('strong');
      prospectName.textContent = cleanGameText(miningSource.prospect.name);
      prospectCopy.append(prospectName);

      const prospectDescription = document.createElement('small');
      prospectDescription.textContent = cleanGameText('Shows regions where this ore can be found.');
      prospectCopy.append(prospectDescription);

      prospectRow.append(prospectCopy);
      prospectRow.addEventListener('click', (event) => {
        event.stopPropagation();
        showItemDetails(miningSource.prospect);
      });
      list.append(prospectRow);
    }

    section.append(list);
    elements.itemDetails.append(section);
  }

  const relatedOre = findOreForProspect(item);
  if (relatedOre) {
    const section = detailSection('Related');
    const list = document.createElement('div');
    list.className = 'entity-list details-related-list';

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'entity-row related-entity-row';
    row.append(createIcon(relatedOre, 'entity-row-icon'));

    const copy = document.createElement('span');
    copy.className = 'entity-row-copy';

    const name = document.createElement('strong');
    name.textContent = cleanGameText(relatedOre.name || relatedOre.rawCode || 'Unknown item');
    copy.append(name);

    const description = document.createElement('small');
    description.textContent = 'Ore associated with this prospect.';
    copy.append(description);

    row.append(copy);
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      showItemDetails(relatedOre);
    });

    list.append(row);
    section.append(list);
    elements.itemDetails.append(section);
  }

  const usages = recipesUsing(item);
  if (usages.length) {
    const section = detailSection('Used in');
    const list = document.createElement('div');
    list.className = 'entity-list details-usage-list';

    usages.forEach(({ item: product, quantity }) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'entity-row usage-entity-row';
      row.append(createIcon(product, 'entity-row-icon'));

      const copy = document.createElement('span');
      copy.className = 'entity-row-copy';

      const name = document.createElement('strong');
      name.textContent = cleanGameText(product.name || product.rawCode || 'Unknown item');
      copy.append(name);

      const meta = document.createElement('small');
      meta.textContent = cleanGameText(`Quantity ×${quantity}`);
      copy.append(meta);

      row.append(copy);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        showItemDetails(product);
      });

      list.append(row);
    });

    section.append(list);
    elements.itemDetails.append(section);
  }

  if (item.scriptStats && Object.keys(item.scriptStats).length) {
    const section = detailSection('Script stats');
    const list = document.createElement('ul');
    list.className = 'details-stat-list';
    Object.entries(item.scriptStats).forEach(([key, value]) => {
      const li = document.createElement('li');
      li.textContent = `${formatStatKey(key)}: ${formatStatValue(key, value)}`;
      list.append(li);
    });
    section.append(list);
    elements.itemDetails.append(section);
  }

  if (item.scriptBehaviors?.length) {
    const section = detailSection('Behaviors');
    const list = document.createElement('ul');
    list.className = 'details-stat-list';
    item.scriptBehaviors.forEach((behavior) => {
      const li = document.createElement('li');
      li.textContent = behavior;
      list.append(li);
    });
    section.append(list);
    elements.itemDetails.append(section);
  }

  if (item.monsterDrops?.length || item.shops?.length) {
    const section = detailSection('Sources');
    const list = document.createElement('div');
    list.className = 'entity-list details-source-list';

    item.monsterDrops?.forEach((drop) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'entity-row monster-entity-row';
      row.dataset.entityType = 'monster';
      row.dataset.monsterName = drop.monsterName || '';

      const icon = document.createElement('span');
      icon.className = 'details-placeholder entity-row-icon monster-row-icon';
      icon.textContent = 'E';
      row.append(icon);

      const copy = document.createElement('span');
      copy.className = 'entity-row-copy';

      const name = document.createElement('strong');
      name.textContent = drop.monsterName || 'Unknown monster';
      copy.append(name);

      const chance = Number(drop.chancePerThousand);
      const meta = document.createElement('small');
      meta.textContent = Number.isFinite(chance)
        ? `${(chance / 10).toFixed(chance % 10 ? 1 : 0)}% drop`
        : 'Drop chance unknown';
      if (drop.difficultyRequirement != null) {
        meta.textContent += ` · difficulty ${drop.difficultyRequirement}`;
      }
      copy.append(meta);

      row.append(copy);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        showMonsterDetails(drop.monsterName);
      });

      list.append(row);
    });

    item.shops?.forEach((shop) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'entity-row shop-entity-row';
      row.dataset.entityType = 'shop';
      row.dataset.shopName = shop.shopName || '';

      const icon = document.createElement('span');
      icon.className = 'details-placeholder entity-row-icon shop-row-icon';
      icon.textContent = 'S';
      row.append(icon);

      const copy = document.createElement('span');
      copy.className = 'entity-row-copy';

      const name = document.createElement('strong');
      name.textContent = shop.shopName || 'Unknown shop';
      copy.append(name);

      const meta = document.createElement('small');
      meta.textContent = shop.categoryName ? `Category · ${shop.categoryName}` : 'Shop source';
      copy.append(meta);

      row.append(copy);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        showShopDetails(shop.shopName);
      });
      list.append(row);
    });

    section.append(list);
    elements.itemDetails.append(section);
  }

  bindItemIconFallbacks(elements.itemDetails);
}

function detailSection(title) {
  const section = document.createElement('section');
  section.className = 'details-section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  section.append(heading);
  return section;
}

function extractTooltipSection(tooltip, heading) {
  const lines = String(tooltip || '').split('\n');
  const index = lines.findIndex((line) => line.trim() === heading);
  if (index < 0) return [];
  const result = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break;
    if (/^[A-Za-z][A-Za-z ]*:$/.test(line.trim())) break;
    result.push(line);
  }
  return result;
}

function tooltipSectionsExcept(tooltip, excludedHeadings) {
  const lines = String(tooltip || '').split('\n');
  const result = [];
  let currentHeading = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[A-Za-z][A-Za-z ]*:$/.test(line)) {
      currentHeading = line;
      continue;
    }
    if (!currentHeading || !excludedHeadings.has(currentHeading)) {
      result.push(rawLine);
    }
  }
  return result;
}

function formatStatKey(key) {
  return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (char) => char.toUpperCase());
}

function bindPanelResizers() {
  const workspace = elements.inspector?.parentElement;
  if (!workspace) return;

  const isDesktop = () => window.matchMedia('(min-width: 981px)').matches;
  const LAYOUT = Object.freeze({ minSide: 280, minMap: 180, gutter: 16, maxSide: 700 });

  function getPanels() {
    return {
      inspector: elements.inspector,
      details: document.querySelector('.details-panel'),
      map: elements.treePanel,
    };
  }

  function getWidths() {
    const panels = getPanels();
    return {
      inspector: panels.inspector?.getBoundingClientRect().width || 0,
      details: panels.details?.getBoundingClientRect().width || 0,
    };
  }

  function applyWidths(inspectorWidth, detailsWidth) {
    if (!isDesktop()) return;
    const hidden = workspace.classList.contains('recipe-map-hidden');
    const total = workspace.getBoundingClientRect().width || window.innerWidth;
    let left = Math.round(Number(inspectorWidth));
    let right = Math.round(Number(detailsWidth));

    if (!Number.isFinite(left) || !Number.isFinite(right)) return;

    if (hidden) {
      const available = Math.max(LAYOUT.minSide * 2, total - 8);
      left = Math.max(LAYOUT.minSide, Math.min(available - LAYOUT.minSide, left));
      right = Math.max(LAYOUT.minSide, available - left);
    } else {
      const maxSideTotal = Math.max(LAYOUT.minSide * 2, total - LAYOUT.minMap - LAYOUT.gutter);
      left = Math.max(LAYOUT.minSide, Math.min(LAYOUT.maxSide, left));
      right = Math.max(LAYOUT.minSide, Math.min(LAYOUT.maxSide, right));
      if (left + right > maxSideTotal) {
        const excess = left + right - maxSideTotal;
        if (left >= right) left -= excess;
        else right -= excess;
        left = Math.max(LAYOUT.minSide, left);
        right = Math.max(LAYOUT.minSide, right);
      }
    }

    workspace.style.setProperty('--inspector-width', `${left}px`);
    workspace.style.setProperty('--details-width', `${right}px`);
  }

  function bindResizer(handle, panelKey) {
    if (!handle) return;
    handle.setAttribute('aria-valuemin', String(LAYOUT.minSide));
    handle.setAttribute('aria-valuemax', String(LAYOUT.maxSide));

    let pointerId = null;
    let startX = 0;
    let startWidth = 0;
    let boundarySign = 1;

    const getPanel = () => panelKey === 'inspector' ? elements.inspector : document.querySelector('.details-panel');

    const stopResize = () => {
      document.body.classList.remove('resizing-panels');
      if (pointerId !== null) handle.releasePointerCapture?.(pointerId);
      pointerId = null;
    };

    handle.addEventListener('pointerdown', (event) => {
      if (!isDesktop()) return;
      const panel = getPanel();
      if (!panel) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      startX = event.clientX;
      startWidth = rect.width;
      const handleCenter = handle.getBoundingClientRect().left + handle.getBoundingClientRect().width / 2;
      const panelCenter = rect.left + rect.width / 2;
      // Right boundary: drag right to grow. Left boundary: drag left to grow.
      boundarySign = handleCenter >= panelCenter ? 1 : -1;
      pointerId = event.pointerId;
      handle.setPointerCapture?.(pointerId);
      document.body.classList.add('resizing-panels');
    });

    handle.addEventListener('pointermove', (event) => {
      if (pointerId !== event.pointerId) return;
      const delta = event.clientX - startX;
      const next = startWidth + delta * boundarySign;
      const widths = getWidths();
      applyWidths(panelKey === 'inspector' ? next : widths.inspector,
                  panelKey === 'details' ? next : widths.details);
    });

    handle.addEventListener('pointerup', (event) => {
      if (pointerId !== event.pointerId) return;
      const widths = getWidths();
      const value = panelKey === 'inspector' ? widths.inspector : widths.details;
      try { localStorage.setItem(panelKey === 'inspector' ? 'hellfire-inspector-width' : 'hellfire-details-width', String(Math.round(value))); } catch {}
      stopResize();
      requestAnimationFrame(() => { if (!workspace.classList.contains('recipe-map-hidden')) fitTree(); });
    });
    handle.addEventListener('pointercancel', stopResize);

    handle.addEventListener('keydown', (event) => {
      if (!isDesktop() || !['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const widths = getWidths();
      const current = panelKey === 'inspector' ? widths.inspector : widths.details;
      const delta = (event.key === 'ArrowRight' ? 20 : -20) * boundarySign;
      applyWidths(panelKey === 'inspector' ? current + delta : widths.inspector,
                  panelKey === 'details' ? current + delta : widths.details);
      const updated = getWidths();
      try { localStorage.setItem(panelKey === 'inspector' ? 'hellfire-inspector-width' : 'hellfire-details-width', String(Math.round(panelKey === 'inspector' ? updated.inspector : updated.details))); } catch {}
      requestAnimationFrame(() => { if (!workspace.classList.contains('recipe-map-hidden')) fitTree(); });
    });
  }

  try {
    const savedLeftRaw = localStorage.getItem('hellfire-inspector-width');
    const savedRightRaw = localStorage.getItem('hellfire-details-width');
    const savedLeft = Number(savedLeftRaw);
    const savedRight = Number(savedRightRaw);
    if (savedLeftRaw !== null && Number.isFinite(savedLeft)) {
      workspace.style.setProperty('--inspector-width', `${Math.round(savedLeft)}px`);
    }
    if (savedRightRaw !== null && Number.isFinite(savedRight)) {
      workspace.style.setProperty('--details-width', `${Math.round(savedRight)}px`);
    }
  } catch {}

  bindResizer(elements.inspectorResizer, 'inspector');
  bindResizer(elements.detailsResizer, 'details');

  if (window.ResizeObserver && elements.viewport) {
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!workspace.classList.contains('recipe-map-hidden')) fitTree();
      });
    });
    observer.observe(workspace);
    observer.observe(elements.viewport);
  }
}

function applyWorkspaceLayout(layout) {
  const workspace = elements.inspector?.parentElement;
  if (!workspace) return;
  const layouts = {
    'summary-map-details': ['inspector','inspector-resizer','tree','details-resizer','details'],
    'map-summary-details': ['tree','inspector-resizer','inspector','details-resizer','details'],
    'summary-details-map': ['inspector','inspector-resizer','details','details-resizer','tree'],
    'details-summary-map': ['details','details-resizer','inspector','inspector-resizer','tree'],
    'map-details-summary': ['tree','details-resizer','details','inspector-resizer','inspector'],
    'details-map-summary': ['details','details-resizer','tree','inspector-resizer','inspector'],
  };
  const order = layouts[layout] || layouts['summary-map-details'];
  const nodes = {
    inspector: elements.inspector,
    'inspector-resizer': elements.inspectorResizer,
    tree: elements.treePanel,
    'details-resizer': elements.detailsResizer,
    details: document.querySelector('.details-panel'),
  };
  order.forEach((key, index) => {
    if (nodes[key]) nodes[key].style.order = String(index + 1);
  });
  workspace.dataset.layout = layout;
  if (elements.layoutSelect && elements.layoutSelect.value !== layout) elements.layoutSelect.value = layout;
  try { localStorage.setItem('hellfire-workspace-layout', layout); } catch {}

  const hidden = workspace.classList.contains('recipe-map-hidden');
  if (hidden) {
    const visible = order.filter(key => key === 'inspector' || key === 'details');
    visible.forEach((key, index) => { if (nodes[key]) nodes[key].style.order = String(index * 2 + 1); });
    if (elements.inspectorResizer) {
      elements.inspectorResizer.style.order = '2';
      elements.inspectorResizer.style.display = 'block';
    }
    if (elements.detailsResizer) elements.detailsResizer.style.display = 'none';
  } else {
    if (elements.inspectorResizer) elements.inspectorResizer.style.display = 'block';
    if (elements.detailsResizer) elements.detailsResizer.style.display = '';
  }
  requestAnimationFrame(() => {
    if (!hidden) fitTree();
  });
}

function bindWorkspaceLayout() {
  if (!elements.layoutSelect) return;
  let layout = 'summary-map-details';
  try { layout = localStorage.getItem('hellfire-workspace-layout') || layout; } catch {}
  applyWorkspaceLayout(layout);
  elements.layoutSelect.addEventListener('change', () => applyWorkspaceLayout(elements.layoutSelect.value));
}

function bindRecipeMapToggle() {
  const button = elements.toggleRecipeMap;
  const workspace = elements.inspector?.parentElement;
  if (!button || !workspace) return;
  const storageKey = 'hellfire-recipe-map-hidden';

  const apply = (hidden) => {
    workspace.classList.toggle('recipe-map-hidden', hidden);
    button.textContent = hidden ? 'Show map' : 'Hide map';
    button.setAttribute('aria-pressed', String(hidden));
    button.setAttribute('aria-label', hidden ? 'Show recipe map' : 'Hide recipe map');
    button.title = hidden ? 'Show recipe map' : 'Hide recipe map';
    if (elements.treePanel) elements.treePanel.setAttribute('aria-hidden', String(hidden));

    if (hidden) {
      // In the two-panel mode the map disappears completely. The remaining
      // panels fill the workspace, while the single middle divider controls
      // their ratio.
      const total = workspace.getBoundingClientRect().width || window.innerWidth;
      const available = Math.max(560, total - 8);
      const currentLeft = elements.inspector?.getBoundingClientRect().width || 0;
      const left = Math.max(280, Math.min(available - 280, Math.round(currentLeft)));
      const right = Math.max(280, Math.round(available - left));
      workspace.style.setProperty('--inspector-width', `${left}px`);
      workspace.style.setProperty('--details-width', `${right}px`);
    } else {
      try {
        const leftRaw = localStorage.getItem('hellfire-inspector-width');
        const rightRaw = localStorage.getItem('hellfire-details-width');
        const left = Number(leftRaw);
        const right = Number(rightRaw);
        if (leftRaw !== null && Number.isFinite(left)) {
          workspace.style.setProperty('--inspector-width', `${Math.round(left)}px`);
        } else {
          workspace.style.removeProperty('--inspector-width');
        }
        if (rightRaw !== null && Number.isFinite(right)) {
          workspace.style.setProperty('--details-width', `${Math.round(right)}px`);
        } else {
          workspace.style.removeProperty('--details-width');
        }
      } catch {}
    }
    requestAnimationFrame(() => {
      const layout = workspace.dataset.layout || elements.layoutSelect?.value || 'summary-map-details';
      applyWorkspaceLayout(layout);
      if (!hidden) fitTree();
    });
  };

  let hidden = false;
  try { hidden = localStorage.getItem(storageKey) === '1'; } catch {}
  apply(hidden);
  button.addEventListener('click', () => {
    hidden = !hidden;
    apply(hidden);
    try { localStorage.setItem(storageKey, hidden ? '1' : '0'); } catch {}
  });
}

function formatStatValue(key, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  const percentKeys = new Set(['damagedone', 'damagetaken', 'spellhealing', 'spelldamage', 'attacklifesteal']);
  return percentKeys.has(String(key).toLowerCase()) ? `${Math.round(number * 100)}%` : String(value);
}

function getOwnedQuantity(item) {
  const code = itemKey(item);
  return Math.max(0, Number(state.craftOwned.get(code)) || 0);
}

function setOwnedQuantity(item, quantity) {
  writeOwnedQuantity(item, quantity);
  renderMaterials(state.ui.selected);
}

function writeOwnedQuantity(item, quantity) {
  const code = itemKey(item);
  if (!code) return;
  const next = Math.max(0, Math.floor(Number(quantity) || 0));
  if (next === 0) state.craftOwned.delete(code);
  else state.craftOwned.set(code, next);
}

function getNestedEntityQuantity(key) {
  return Math.max(0, Math.floor(Number(state.nestedOwned.get(String(key))) || 0));
}

function writeNestedEntityQuantity(key, quantity) {
  const next = Math.max(0, Math.floor(Number(quantity) || 0));
  const normalized = String(key || '');
  if (!normalized) return;
  if (next === 0) state.nestedOwned.delete(normalized);
  else state.nestedOwned.set(normalized, next);
}

function buildNestedEntities(root) {
  const entities = [];
  function visit(item, required, key, depth, ancestorCodes, parentKey = null, perParent = 1) {
    if (!item) return;
    const code = itemKey(item);
    const cycle = !code || ancestorCodes.has(code);
    const entity = { item, required: Math.max(1, Math.floor(Number(required) || 1)), key, depth, parentKey, perParent, cycle, children: [] };
    entities.push(entity);
    if (cycle || !item.recipe?.length) return;
    const nextCodes = new Set(ancestorCodes); nextCodes.add(code);
    recipeChildren(item).forEach(({ item: child, quantity }, index) => {
      const childKey = `${key}/${index}`;
      const edge = Math.max(1, Math.floor(Number(quantity) || 1));
      const childEntity = visit(child, entity.required * edge, childKey, depth + 1, nextCodes, key, edge);
      if (childEntity) entity.children.push(childEntity);
    });
    return entity;
  }
  recipeChildren(root).forEach(({ item, quantity }, index) => visit(item, quantity, String(index), 0, new Set(), null, 1));
  return entities;
}

function cascadeNestedEntityQuantity(item, key, units) {
  const amount = Math.max(0, Math.floor(Number(units) || 0));
  writeNestedEntityQuantity(key, amount);
  if (!item?.recipe?.length) return;
  const code = itemKey(item);
  const walk = (node, parentKey, multiplier, pathCodes) => {
    const nodeCode = itemKey(node);
    if (!nodeCode || pathCodes.has(nodeCode) || !node.recipe?.length) return;
    const nextCodes = new Set(pathCodes); nextCodes.add(nodeCode);
    recipeChildren(node).forEach(({ item: child, quantity }, index) => {
      const childKey = `${parentKey}/${index}`;
      const childAmount = amount * multiplier * Math.max(1, Math.floor(Number(quantity) || 1));
      writeNestedEntityQuantity(childKey, childAmount);
      walk(child, childKey, multiplier * Math.max(1, Math.floor(Number(quantity) || 1)), nextCodes);
    });
  };
  walk(item, key, 1, new Set([code]));
}

function reconcileNestedEntityAncestors(root, changedKey) {
  const entities = buildNestedEntities(root);
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  let current = byKey.get(String(changedKey || ''));

  // Reconcile only the strict parent chain of the occurrence that changed.
  // Sibling occurrences are independent entities and must never be recalculated
  // merely because another occurrence of the same item was edited.
  while (current?.parentKey != null) {
    const parent = byKey.get(current.parentKey);
    if (!parent || parent.cycle || !parent.children.length) break;

    let craftable = Infinity;
    for (const child of parent.children) {
      const childOwned = getNestedEntityQuantity(child.key);
      craftable = Math.min(craftable, Math.floor(childOwned / Math.max(1, child.perParent)));
    }
    const next = Number.isFinite(craftable)
      ? Math.max(0, Math.min(parent.required, craftable))
      : 0;
    writeNestedEntityQuantity(parent.key, next);
    current = parent;
  }
  return byKey;
}

function setNestedEntityQuantity(item, key, required, quantity) {
  const maxRequired = Math.max(1, Math.floor(Number(required) || 1));
  const next = Math.max(0, Math.min(maxRequired, Math.floor(Number(quantity) || 0)));
  const isCraftable = Boolean(item?.recipe?.length);

  // A direct edit of a craftable occurrence is an explicit statement that this
  // particular parent occurrence exists in the requested amount. Propagate it
  // down its own path, but do not immediately run the reverse solver over the
  // same node: that would allow an incomplete sibling occurrence to snap the
  // just-entered parent back to zero. Leaf edits, on the other hand, derive
  // their strict ancestors from the available child quantities.
  if (isCraftable) {
    cascadeNestedEntityQuantity(item, key, next);
  } else {
    writeNestedEntityQuantity(key, next);
    if (state.ui.selected) reconcileNestedEntityAncestors(state.ui.selected, key);
  }
  renderMaterials(state.ui.selected);
}

// Single source of truth for wiping both owned-quantity stores. Quick-view recipe
// switches and the explicit "reset all" button both reduce to this.
function clearOwnedQuantities() {
  state.craftOwned.clear();
  state.nestedOwned.clear();
}

function beginQuickViewRecipe(item) {
  // Quick-view ownership is temporary and scoped to the currently selected recipe.
  // Switching recipes always starts from 0 and does not become persistent planner data.
  clearOwnedQuantities();
}

function resetAllOwnedQuantities() {
  clearOwnedQuantities();
  state.nestedExpanded = new Set();
  renderMaterials(state.ui.selected);
}

function createOwnedControl(item, required, compact = false, options = {}) {
  const wrap = document.createElement('div');
  wrap.className = `owned-control${compact ? ' compact' : ''}`;
  const maxRequired = Math.max(1, Math.floor(Number(required) || 1));
  const readQuantity = typeof options.getQuantity === 'function' ? options.getQuantity : () => getOwnedQuantity(item);
  const writeQuantity = typeof options.setQuantity === 'function' ? options.setQuantity : (value) => setOwnedQuantity(item, value);
  const owned = Math.min(readQuantity(), maxRequired);
  const readOnly = Boolean(options.readOnly);
  const displayQuantity = Number.isFinite(Number(options.displayQuantity))
    ? Math.max(0, Math.floor(Number(options.displayQuantity)))
    : owned;
  const displayTotal = Number.isFinite(Number(options.displayTotal))
    ? Math.max(1, Math.floor(Number(options.displayTotal)))
    : maxRequired;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'owned-check';
  checkbox.checked = displayQuantity >= displayTotal;
  checkbox.disabled = readOnly;
  checkbox.title = readOnly
    ? `Progress: ${displayQuantity} / ${displayTotal}`
    : (checkbox.checked ? 'Mark as not owned' : 'Mark as done');
  if (!readOnly) {
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      writeQuantity(checkbox.checked ? maxRequired : 0);
    });
  }
  wrap.append(checkbox);

  const controls = document.createElement('span');
  controls.className = 'owned-quantity-controls';

  // Every view uses the same 0/required input model, including items that need
  // only one unit. This keeps the control predictable and guarantees 1/1 is visible.
  const value = document.createElement('input');
  value.type = 'number';
  value.className = 'owned-value';
  value.min = '0';
  value.max = String(displayTotal);
  value.step = '1';
  value.inputMode = 'numeric';
  value.value = String(displayQuantity);
  value.readOnly = readOnly;
  value.title = readOnly
    ? `Progress: ${displayQuantity} / ${displayTotal}.`
    : `Enter a number or use the mouse wheel. Current: ${owned} / ${maxRequired}.`;
  value.setAttribute('aria-label', `${readOnly ? 'Progress' : 'Owned'} quantity of ${item?.name || 'item'}, maximum ${displayTotal}`);
  if (!readOnly) {
    value.addEventListener('click', (event) => event.stopPropagation());
    value.addEventListener('change', (event) => {
      event.stopPropagation();
      const parsed = Number(value.value);
      const current = readQuantity();
      writeQuantity(Number.isFinite(parsed)
        ? Math.min(maxRequired, Math.max(0, Math.floor(parsed)))
        : current);
    });
    value.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = Math.min(readQuantity(), maxRequired);
      const delta = event.deltaY < 0 ? 1 : -1;
      writeQuantity(Math.min(maxRequired, Math.max(0, current + delta)));
    }, { passive: false });
  }
  controls.append(value);

  const requiredLabel = document.createElement('span');
  requiredLabel.className = 'owned-required';
  requiredLabel.textContent = `/ ${displayTotal}`;
  requiredLabel.title = `Required total: ${displayTotal}`;
  controls.append(requiredLabel);

  wrap.append(controls);
  return wrap;
}

function rarityRank(item) {
  const value = normalizeText(item?.quality || item?.rarity || '');
  // Hellfire RPG rarity progression, from lowest to highest.
  const ranks = new Map([
    ['junk', 0],
    ['basic', 1],
    ['magical', 2],
    ['rare', 3],
    ['epic', 4],
    ['legendary', 5],
    ['mythical', 6],
    ['mythic', 6],
    ['artifact', 7],
  ]);

  if (!value) return 0;
  if (ranks.has(value)) return ranks.get(value);

  for (const [name, rank] of ranks) {
    if (value.includes(name)) return rank;
  }
  return 0;
}

function summaryEntryCompleted(entry) {
  const total = state.summarySyncNested ? Number(entry.requiredTotal || 0) : Number(entry.quantity || 0);
  const acquired = state.summarySyncNested ? Number(entry.acquired || 0) : Number(getOwnedQuantity(entry.item) || 0);
  return total > 0 && acquired >= total;
}

function compareSummaryEntries(left, right) {
  if (state.summaryDeprioritizeCompleted) {
    const leftDone = summaryEntryCompleted(left);
    const rightDone = summaryEntryCompleted(right);
    if (leftDone !== rightDone) return leftDone ? 1 : -1;
  }

  // The selected criterion is always the primary sort. The other criterion is
  // only a tie-breaker. Quantity means the required amount for this recipe,
  // not the amount already collected. This keeps sorting stable in sync mode.
  const primaryKey = state.summarySort.mode === 'quantity' ? 'quantity' : 'rarity';
  const secondaryKey = primaryKey === 'quantity' ? 'rarity' : 'quantity';
  const direction = (key) => key === 'quantity' ? state.summarySort.quantityOrder : state.summarySort.rarityOrder;
  const value = (entry, key) => {
    if (key === 'quantity') return state.summarySyncNested ? Number(entry.requiredTotal || 0) : Number(entry.quantity || 0);
    return rarityRank(entry.item);
  };

  for (const key of [primaryKey, secondaryKey]) {
    const a = value(left, key);
    const b = value(right, key);
    if (a !== b) return direction(key) === 'asc' ? a - b : b - a;
  }
  return String(left.item.name || '').localeCompare(String(right.item.name || ''));
}

function saveSummarySettings() {
  try {
    localStorage.setItem('hellfire-summary-settings', JSON.stringify({
      sort: state.summarySort,
      sync: state.summarySyncNested,
      deprioritizeCompleted: state.summaryDeprioritizeCompleted,
      dimCompleted: state.summaryDimCompleted,
    }));
  } catch {}
}

function loadSummarySettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('hellfire-summary-settings') || '{}');
    if (raw?.sort) {
      const oldMode = raw.sort.mode;
      const migratedMode = oldMode === 'quantity-rarity' ? 'quantity' : 'rarity';
      const quantityOrder = raw.sort.quantityOrder
        || (oldMode === 'quantity-rarity' ? raw.sort.primary : raw.sort.secondary)
        || 'desc';
      const rarityOrder = raw.sort.rarityOrder
        || (oldMode === 'quantity-rarity' ? raw.sort.secondary : raw.sort.primary)
        || 'desc';
      state.summarySort = { ...state.summarySort, mode: migratedMode, quantityOrder, rarityOrder };
    }
    state.summarySyncNested = Boolean(raw?.sync);
    state.summaryDeprioritizeCompleted = Boolean(raw?.deprioritizeCompleted);
    state.summaryDimCompleted = Boolean(raw?.dimCompleted);
  } catch {}
}

function bindSummarySettings() {
  loadSummarySettings();
  if (elements.summarySortMode) elements.summarySortMode.value = state.summarySort.mode;
  if (elements.summaryQuantityOrder) elements.summaryQuantityOrder.value = state.summarySort.quantityOrder;
  if (elements.summaryRarityOrder) elements.summaryRarityOrder.value = state.summarySort.rarityOrder;
  if (elements.summarySyncNested) elements.summarySyncNested.checked = state.summarySyncNested;
  if (elements.summaryDeprioritizeCompleted) elements.summaryDeprioritizeCompleted.checked = state.summaryDeprioritizeCompleted;
  if (elements.summaryDimCompleted) elements.summaryDimCompleted.checked = state.summaryDimCompleted;

  elements.summarySettingsToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !elements.summarySettingsPanel.hidden;
    elements.summarySettingsPanel.hidden = open;
    elements.summarySettingsToggle.setAttribute('aria-expanded', String(!open));
  });
  // Every summary-setting control follows the same pattern: read its value/checked
  // state into `state`, persist, then re-render. Declare the mapping once instead
  // of repeating the same three-line handler six times.
  const settingBindings = [
    { element: elements.summarySortMode, apply: () => { state.summarySort.mode = elements.summarySortMode.value === 'quantity' ? 'quantity' : 'rarity'; } },
    { element: elements.summaryQuantityOrder, apply: () => { state.summarySort.quantityOrder = elements.summaryQuantityOrder.value; } },
    { element: elements.summaryRarityOrder, apply: () => { state.summarySort.rarityOrder = elements.summaryRarityOrder.value; } },
    { element: elements.summarySyncNested, apply: () => { state.summarySyncNested = elements.summarySyncNested.checked; } },
    { element: elements.summaryDeprioritizeCompleted, apply: () => { state.summaryDeprioritizeCompleted = elements.summaryDeprioritizeCompleted.checked; } },
    { element: elements.summaryDimCompleted, apply: () => { state.summaryDimCompleted = elements.summaryDimCompleted.checked; } },
  ];
  settingBindings.forEach(({ element, apply }) => {
    element?.addEventListener('change', () => {
      apply();
      saveSummarySettings();
      renderMaterials(state.ui.selected);
    });
  });

  elements.summaryResetOwned?.addEventListener('click', () => resetAllOwnedQuantities());
}

function renderMaterials(item) {
  const source = state.summarySyncNested ? collectSyncedBaseMaterials(item) : collectBaseMaterials(item);
  const rows = [...source.values()].sort(compareSummaryEntries);
  elements.materialsList.replaceChildren();
  elements.nestedCraftingList.replaceChildren();

  const total = rows.reduce((sum,e) => sum + (state.summarySyncNested ? e.requiredTotal : e.quantity), 0);
  elements.materialTotal.textContent = `${rows.length} types · ${total} total`;

  rows.forEach(({item: material, quantity, requiredTotal, acquired}) => {
    const row = document.createElement('button');
    row.type='button'; row.className='material-row';
    if (state.summaryDimCompleted && summaryEntryCompleted({ item: material, quantity, requiredTotal, acquired })) row.classList.add('completed-material');
    row.title=`Show details for ${material.name || 'item'}`;
    row.append(createIcon(material,'material-placeholder'));

    const name=document.createElement('div'); name.className='material-name'; name.textContent=material.name;
    const kind=document.createElement('span'); kind.className='material-kind';
    kind.textContent=material.quality || 'Base material'; name.append(kind);
    const control = state.summarySyncNested
      ? createOwnedControl(material, Math.max(1, requiredTotal || quantity), false, {
          readOnly: true,
          displayQuantity: Math.max(0, Math.min(acquired || 0, requiredTotal || quantity)),
          displayTotal: Math.max(1, requiredTotal || quantity),
        })
      : createOwnedControl(material, quantity);
    if (state.summarySyncNested) control.classList.add('sync-display');
    row.append(name, control);
    row.addEventListener('click',()=>showItemDetails(material));
    elements.materialsList.append(row);
  });

  renderNestedCrafting(item);
  applySummaryTab();
}

// In synchronized mode Base Materials is a progress view of the Nested Crafting
// tree. It starts at 0/N and gains progress from owned/completed nested nodes.
function collectSyncedBaseMaterials(root) {
  // Sync mode is derived from the Nested Crafting occurrence tree itself.
  // Every occurrence has its own path key, so equal item codes in different
  // branches never share progress. A parent's owned amount implies the same
  // proportional amount of every descendant; an explicitly owned child can
  // only increase that effective amount, never erase progress inherited from
  // its parent. Base Materials then aggregates the effective leaf quantities
  // of all occurrences with the same item code.
  const totals = new Map();

  function visit(item, required, key, inheritedUnits, ancestorCodes) {
    if (!item) return;
    const ownUnits = getNestedEntityQuantity(key);
    const effectiveUnits = Math.max(ownUnits, Math.max(0, Number(inheritedUnits) || 0));
    const cappedUnits = Math.min(Math.max(1, Math.floor(Number(required) || 1)), Math.floor(effectiveUnits));
    const code = itemKey(item);
    if (!code || ancestorCodes.has(code)) return;

    if (!item.recipe?.length) {
      const existing = totals.get(code) || {
        item,
        quantity: 0,
        requiredTotal: 0,
        acquired: 0,
      };
      existing.requiredTotal += Math.max(1, Math.floor(Number(required) || 1));
      existing.acquired += cappedUnits;
      totals.set(code, existing);
      return;
    }

    const nextAncestors = new Set(ancestorCodes);
    nextAncestors.add(code);
    recipeChildren(item).forEach(({ item: child, quantity }, index) => {
      const edge = Math.max(1, Math.floor(Number(quantity) || 1));
      const childRequired = Math.max(1, Math.floor(Number(required) || 1)) * edge;
      const childInherited = cappedUnits * edge;
      visit(child, childRequired, `${key}/${index}`, childInherited, nextAncestors);
    });
  }

  recipeChildren(root).forEach(({ item, quantity }, index) => {
    const required = Math.max(1, Math.floor(Number(quantity) || 1));
    visit(item, required, String(index), 0, new Set());
  });

  for (const entry of totals.values()) {
    entry.acquired = Math.max(0, Math.min(entry.requiredTotal, entry.acquired));
    entry.quantity = entry.acquired;
  }
  return totals;
}

function renderNestedCrafting(root) {
  const container = elements.nestedCraftingList;
  if (!root?.recipe?.length) {
    const note = document.createElement('div'); note.className = 'empty-note';
    note.textContent = 'This item has no crafting requirements.'; container.append(note); return;
  }
  const tree = document.createElement('div'); tree.className = 'nested-tree';
  recipeChildren(root).forEach(({ item, quantity }, index) => {
    tree.append(createNestedCraftRow(item, quantity, 0, [String(index)], new Set()));
  });
  container.append(tree);
}

function createNestedCraftRow(item, required, depth, path, ancestorPath) {
  const row = document.createElement('div'); row.className = 'nested-row';
  row.style.setProperty('--nested-depth', depth);
  const branchKey = path.join('/');
  const requiredAmount = Math.max(1, Math.floor(Number(required) || 1));
  const nestedOwned = getNestedEntityQuantity(branchKey);
  if (state.summaryDimCompleted && nestedOwned >= requiredAmount) row.classList.add('completed-material');
  const code = itemKey(item);
  const hasRecipe = Boolean(item.recipe?.length);
  const cycle = ancestorPath.has(code);
  const expanded = hasRecipe && !cycle && state.nestedExpanded.has(branchKey);

  const children = document.createElement('div'); children.className = 'nested-children';
  children.hidden = !expanded;
  const line = document.createElement('div'); line.className = 'nested-line';

  const expand = document.createElement('button');
  expand.type = 'button'; expand.className = 'nested-expand';
  expand.textContent = hasRecipe && !cycle ? (expanded ? '−' : '+') : '·';
  expand.disabled = !hasRecipe || cycle;
  expand.setAttribute('aria-expanded', String(expanded));
  expand.setAttribute('aria-label', hasRecipe && !cycle ? `${expanded ? 'Collapse' : 'Expand'} ${item.name}` : 'No sub-recipe');
  line.append(expand);

  const itemButton = document.createElement('button');
  itemButton.type = 'button'; itemButton.className = 'nested-item';
  itemButton.title = `Show details for ${item.name || 'item'}`;
  itemButton.append(createIcon(item, 'nested-placeholder'));

  const copy = document.createElement('span'); copy.className = 'nested-copy';
  const name = document.createElement('strong'); name.textContent = item.name || 'Unknown item';
  const meta = document.createElement('small');
  meta.textContent = required > 1 ? `Required ×${required}` : (hasRecipe ? 'Craftable' : 'Base material');
  copy.append(name, meta); itemButton.append(copy);

  // Checkbox is deliberately placed immediately before the item/icon.
  const ownedControl = createOwnedControl(item, requiredAmount, true, {
    getQuantity: () => getNestedEntityQuantity(branchKey),
    setQuantity: (value) => setNestedEntityQuantity(item, branchKey, requiredAmount, value),
  });
  const quantityControls = ownedControl.querySelector('.owned-quantity-controls');
  if (quantityControls) quantityControls.classList.add('nested-quantity');
  // Keep the complete ownership control inside the item card. This prevents
  // the quantity field from creating a dead grid area outside the card and
  // guarantees the checkbox, value and required amount share the card background.
  itemButton.prepend(ownedControl);
  line.append(itemButton);
  row.append(line, children);

  itemButton.addEventListener('click', (event) => { event.stopPropagation(); showItemDetails(item); });

  if (hasRecipe && !cycle) {
    const populate = () => {
      if (children.childElementCount) return;
      const nextAncestorPath = new Set(ancestorPath); nextAncestorPath.add(code);
      // Child quantities are multiplied by the number of this item required by the parent.
      recipeChildren(item).forEach(({ item: child, quantity }, index) => {
        const totalRequired = required * quantity;
        children.append(createNestedCraftRow(child, totalRequired, depth + 1, [...path, String(index)], nextAncestorPath));
      });
    };
    if (expanded) populate();
    expand.addEventListener('click', (event) => {
      event.stopPropagation();
      if (children.hidden) {
        populate();
        state.nestedExpanded.add(branchKey);
      } else {
        state.nestedExpanded.delete(branchKey);
      }
      children.hidden = !children.hidden;
      expand.textContent = children.hidden ? '+' : '−';
      expand.setAttribute('aria-expanded', String(!children.hidden));
      expand.setAttribute('aria-label', `${children.hidden ? 'Expand' : 'Collapse'} ${item.name}`);
    });
  }
  return row;
}

function applySummaryTab() {
  const nested=state.summaryTab==='nested';
  if (elements.materialsList) elements.materialsList.hidden=nested;
  if (elements.nestedCraftingList) elements.nestedCraftingList.hidden=!nested;
  if (elements.summaryTitle) elements.summaryTitle.textContent=nested?'Nested crafting':'Base materials';
  if (elements.summaryTabMaterials) {
    elements.summaryTabMaterials.classList.toggle('active',!nested);
    elements.summaryTabMaterials.setAttribute('aria-selected',String(!nested));
  }
  if (elements.summaryTabNested) {
    elements.summaryTabNested.classList.toggle('active',nested);
    elements.summaryTabNested.setAttribute('aria-selected',String(nested));
  }
}

function collectBaseMaterials(root) {
  const totals = new Map();
  const visit = (item, multiplier, path) => {
    const code = itemKey(item);
    if (path.has(code) || !item.recipe?.length) {
      const existing = totals.get(code) || { item, quantity: 0 };
      existing.quantity += multiplier; totals.set(code, existing); return;
    }
    const nextPath = new Set(path);
    nextPath.add(code);
    recipeChildren(item).forEach(({ item: ingredient, quantity }) => visit(ingredient, multiplier * quantity, nextPath));
  };
  visit(root, 1, new Set()); return totals;
}

function recipeStats(root) {
  const materials = collectBaseMaterials(root);
  const walk = (item, path) => {
    const code = itemKey(item);
    if (path.has(code) || !item.recipe?.length) return { depth: 1, nodes: 1 };
    const nextPath = new Set(path);
    nextPath.add(code);
    const childStats = recipeChildren(item).map(({ item: ingredient }) => walk(ingredient, nextPath));
    return { depth: 1 + Math.max(...childStats.map((entry) => entry.depth)), nodes: 1 + childStats.reduce((sum, entry) => sum + entry.nodes, 0) };
  };
  return { ...walk(root, new Set()), baseTypes: materials.size };
}

function recipeChildren(item) {
  return (item.recipe || []).map((ingredient) => ({
    item: state.indexes.byCode.get(normalizeCode(ingredient.rawCode)) || { rawCode: ingredient.rawCode, name: ingredient.name || 'Unknown ingredient', recipe: [] },
    quantity: Math.max(1, Number(ingredient.quantity) || 1),
  }));
}

function buildUsedByIndex() {
  // This is a player-facing usage index; technical/internal products are excluded.
  const buckets = new Map();
  state.data.items.forEach((product) => {
    if (!product.recipe?.length || !isPlayerFacing(product)) return;
    product.recipe.forEach((ingredient) => {
      const ingredientCode = normalizeCode(ingredient.rawCode);
      const productCode = normalizeCode(product.rawCode);
      if (!ingredientCode || !productCode) return;
      if (!buckets.has(ingredientCode)) buckets.set(ingredientCode, new Map());
      const products = buckets.get(ingredientCode);
      const existing = products.get(productCode) || { item: product, quantity: 0 };
      existing.quantity += Math.max(1, Number(ingredient.quantity) || 1);
      products.set(productCode, existing);
    });
  });
  return new Map([...buckets].map(([code, products]) => [
    code,
    [...products.values()].sort((left, right) => left.item.name.localeCompare(right.item.name)),
  ]));
}

function hasCraftingUsages(item) {
  const code = normalizeCode(item?.rawCode);
  return Boolean(code && state.indexes.usedBy instanceof Map && state.indexes.usedBy.has(code));
}

function craftingUsageCount(item) {
  const code = normalizeCode(item?.rawCode);
  if (!code || !(state.indexes.usedBy instanceof Map)) return 0;
  const entries = state.indexes.usedBy.get(code);
  return Array.isArray(entries) ? entries.length : 0;
}

function recipesUsing(item) {
  return state.indexes.usedBy.get(normalizeCode(item.rawCode)) || [];
}

function isOreItem(item) {
  if (!item) return false;
  const text = [
    item.name,
    item.description,
    item.plainExtendedTooltip,
    item.rawExtendedTooltip
  ].filter(Boolean).join(' ').toLowerCase();

  // Only infer world-mining status from explicit ore/mining terminology.
  // Do not infer hard-coded stats such as tool level, HP, yield or drop rate.
  const name = String(item.name || '').trim();
  return /\bore\b/i.test(name) ||
         /\b(?:mine|mining|ore vein|ore veins|vein)\b/i.test(text);
}

function findProspectForOre(item) {
  if (!item || !state.data.items) return null;

  const oreName = String(item.name || '').trim();
  if (!oreName) return null;

  const normalized = oreName
    .replace(/\s+ore$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const candidates = state.data.items.filter(candidate => {
    const name = String(candidate.name || '').trim();
    if (!/^Prospect for .+ Veins$/i.test(name)) return false;
    const match = name.match(/^Prospect for (.+) Veins$/i);
    if (!match) return false;
    return match[1].trim().toLowerCase() === normalized.toLowerCase();
  });

  return candidates[0] || null;
}

function findOreForProspect(item) {
  if (!item || !state.data.items) return null;

  const name = cleanGameText(item.name || '').trim();
  const match = name.match(/^Prospect for (.+?) Veins?$/i);
  if (!match) return null;

  const baseName = match[1].trim();
  const wanted = `${baseName} Ore`.replace(/\s+/g, ' ').trim().toLowerCase();

  return state.data.items.find(candidate => {
    const candidateName = cleanGameText(candidate.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return candidateName === wanted;
  }) || null;
}

function getWorldMiningSource(item) {
  if (!isOreItem(item)) return null;
  return {
    type: 'world-mining',
    label: 'World Mining',
    description: 'Mine from an ore vein in the world.',
    prospect: findProspectForOre(item)
  };
}

function cleanGameText(value) {
  if (value == null) return '';

  return String(value)
    // Warcraft III color escape: |cffRRGGBB ... |r
    .replace(/\|cff[0-9a-fA-F]{6}/g, '')
    .replace(/\|r/g, '')
    // Other common Warcraft III inline control sequences.
    .replace(/\|c[0-9a-fA-F]{8}/g, '')
    .replace(/\|n/g, '\n')
    .replace(/\|t/g, '')
    .replace(/\|h/g, '')
    .replace(/\|H[^|]*\|h/g, '')
    .replace(/\|[a-zA-Z]/g, '');
}

function getEntityPlaceholder(entityType) {
  switch (String(entityType || '').toLowerCase()) {
    case 'item':
      return 'I';
    case 'enemy':
    case 'monster':
      return 'E';
    case 'shop':
    case 'npc':
      return 'S';
    default:
      return '?';
  }
}

function createEntityPlaceholder(entityType, className = '') {
  const placeholder = document.createElement('span');
  placeholder.className = `details-placeholder ${className}`.trim();
  placeholder.dataset.entityPlaceholder = getEntityPlaceholder(entityType);
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.textContent = getEntityPlaceholder(entityType);
  return placeholder;
}

function createIcon(item, placeholderClass) {
  const placeholder = () => createEntityPlaceholder('item', placeholderClass);

  if (item?.iconFile) {
    const image = document.createElement('img');
    image.src = item.iconFile;
    image.alt = '';
    image.loading = 'lazy';
    image.draggable = false;
    image.className = placeholderClass || '';

    image.addEventListener('error', () => {
      if (image.isConnected) image.replaceWith(placeholder());
    }, { once: true });

    // Covers cached 404s / already-completed failed images.
    if (image.complete && image.naturalWidth === 0) {
      queueMicrotask(() => {
        if (image.isConnected) image.replaceWith(placeholder());
      });
    }

    return image;
  }

  return placeholder();
}

function metric(value, label) {
  const box = document.createElement('div'); box.className = 'metric';
  const number = document.createElement('strong'); number.textContent = value;
  const caption = document.createElement('span'); caption.textContent = label;
  box.append(number, caption); return box;
}

function fitTree() {
  if (!elements.stage.firstElementChild) return;
  const availableWidth = elements.viewport.clientWidth - 60;
  const availableHeight = elements.viewport.clientHeight - 80;
  const treeWidth = elements.stage.scrollWidth;
  const treeHeight = elements.stage.scrollHeight;
  state.viewport.scale = clamp(Math.min(1, availableWidth / treeWidth, availableHeight / treeHeight), .2, 1.35);
  state.viewport.x = Math.max(30, (elements.viewport.clientWidth - treeWidth * state.viewport.scale) / 2);
  state.viewport.y = 34; applyTransform();
}

function zoomAt(factor, centerX = elements.viewport.clientWidth / 2, centerY = elements.viewport.clientHeight / 2) {
  const previous = state.viewport.scale;
  const next = clamp(previous * factor, .2, 1.8);
  const stageX = (centerX - state.viewport.x) / previous;
  const stageY = (centerY - state.viewport.y) / previous;
  state.viewport.scale = next; state.viewport.x = centerX - stageX * next; state.viewport.y = centerY - stageY * next; applyTransform();
}

function handleWheel(event) {
  event.preventDefault();
  const bounds = elements.viewport.getBoundingClientRect();
  zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - bounds.left, event.clientY - bounds.top);
}

function startDrag(event) {
  if (event.button !== 0 || event.target.closest('.view-controls')) return;
  event.preventDefault();
  elements.viewport.setPointerCapture(event.pointerId);
  state.viewport.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: state.viewport.x, originY: state.viewport.y, moved: false };
}

function moveDrag(event) {
  if (!state.viewport.drag || state.viewport.drag.pointerId !== event.pointerId) return;
  const deltaX = event.clientX - state.viewport.drag.startX;
  const deltaY = event.clientY - state.viewport.drag.startY;
  if (!state.viewport.drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
  if (!state.viewport.drag.moved) {
    state.viewport.drag.moved = true; elements.viewport.classList.add('dragging');
  }
  state.viewport.x = state.viewport.drag.originX + deltaX;
  state.viewport.y = state.viewport.drag.originY + deltaY; applyTransform();
}

function stopDrag(event) {
  if (!state.viewport.drag || state.viewport.drag.pointerId !== event.pointerId) return;
  state.viewport.drag = null; elements.viewport.classList.remove('dragging');
}

function applyTransform() {
  elements.stage.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.scale})`;
  elements.zoomValue.value = `${Math.round(state.viewport.scale * 100)}%`;
  elements.zoomValue.textContent = `${Math.round(state.viewport.scale * 100)}%`;
}

function searchScore(item, needle) {
  if (!needle) return 10;
  const name = normalizeText(item.name);
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.split(' ').some((word) => word.startsWith(needle))) return 2;
  return name.includes(needle) ? 3 : 99;
}

function itemSummary(item) {
  return [item.quality, item.slot, item.requiredLevel ? `Level ${item.requiredLevel}` : null].filter(Boolean).join(' · ') || 'Crafted item';
}

function isPlayerFacing(item) {
  // Current source data does not expose a dedicated visibility flag, so this remains
  // a deliberately isolated heuristic that can be replaced if the schema changes.
  const name = String(item.name || '');
  return (!name.includes('(') && !name.includes(')')) || PLAYER_ITEM_ALLOWLIST.has(name);
}

function cleanMapName(value) { return String(value || 'Hellfire RPG').replace(/\.w3x$/i, ''); }
function normalizeText(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function normalizeCode(value) { return String(value || '').trim().toLowerCase(); }
// Canonical identity for an item: prefer its map code, fall back to its normalized
// name. Every piece of code that needs to key/compare/deduplicate items should use
// this instead of re-deriving the same fallback chain locally.
function itemKey(item) { return normalizeCode(item?.rawCode) || normalizeText(item?.name); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }

function showError(message) {
  elements.loading.hidden = false; elements.loading.replaceChildren();
  const error = document.createElement('div'); error.className = 'error-state'; error.textContent = message;
  elements.loading.append(error); elements.dataNote.textContent = 'Map data unavailable'; elements.gestureHint.hidden = true;
}

function registerWebMcpTool() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  try {
    void Promise.resolve(context.registerTool({
      name: 'select_crafted_item',
      title: 'Select crafted item',
      description: 'Select a Hellfire RPG crafted item and display its complete recursive ingredient and upgrade trees.',
      inputSchema: {
        type: 'object',
        properties: { itemName: { type: 'string', description: 'The crafted item name to select.' } },
        required: ['itemName'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const requestedName = normalizeText(input?.itemName);
        if (!requestedName) throw new Error('itemName is required.');
        const exact = state.data.craftedItems.find((item) => normalizeText(item.name) === requestedName);
        const matches = exact ? [exact] : state.data.craftedItems.filter((item) => normalizeText(item.name).includes(requestedName));
        if (matches.length !== 1) {
          throw new Error(matches.length ? `More than one crafted item matches "${input.itemName}".` : `No crafted item matches "${input.itemName}".`);
        }
        selectItem(matches[0]);
        const stats = recipeStats(matches[0]);
        return { item: matches[0].name, layers: stats.depth, treeItems: stats.nodes, baseMaterialTypes: stats.baseTypes };
      },
    })).catch((error) => console.warn('WebMCP registration failed:', error));
  } catch (error) {
    console.warn('WebMCP registration failed:', error);
  }
}


