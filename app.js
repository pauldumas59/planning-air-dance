// Planning Air Dance — version site autonome de bsport-planning.user.js.
//
// Même principe que le userscript : lecture seule via l'API bsport, chaque
// cours est un lien vers leur page de réservation. Différence : on n'est plus
// sur leur domaine, donc pas de jeton à intercepter — on en obtient un via
// leur propre endpoint de connexion, et on le garde dans le stockage local.
//
// L'API répond « Access-Control-Allow-Origin: * » et autorise l'en-tête
// Authorization en préflight : les appels depuis un autre domaine passent
// (vérifié le 2026-10-26). Le planning lui-même est public, sans jeton.

(() => {
  'use strict';

  // GitHub Pages ne permet pas d'envoyer frame-ancestors : on refuse de
  // tourner dans un cadre, pour qu'aucun site ne superpose la connexion.
  if (window.top !== window.self) {
    document.body.replaceChildren(Object.assign(document.createElement('a'), {
      href: location.href, target: '_blank', rel: 'noopener', textContent: 'Ouvrir le planning',
    }));
    return;
  }

  const COMPANY = 1272;
  const API = 'https://api.production.bsport.io';
  const SITE = 'https://backoffice.bsport.io';
  const TZ = 'Europe/Paris';
  const BOOKING_URL = (offerId) => `${SITE}/booker-module-s/${COMPANY}/${offerId}?membership=${COMPANY}`;
  const STORE_KEY = 'bsport-planning:filters';
  const TOKEN_KEY = 'bsport-planning:token';
  const STALE_MS = 10 * 60000;   // au retour sur l'app après 10 min, on recharge la semaine

  // Relevés dans leur barre de navigation le 2026-10-26. Les paramètres
  // tabSelected/index ne servent qu'à surligner leur onglet actif.
  const STUDIO = `${SITE}/m/Air%20Dance%20Studio/${COMPANY}`;
  const LINKS = {
    account: [
      ['Mes réservations', `${SITE}/c/${COMPANY}/booking/?membership=${COMPANY}`],
      ['Panier', `${SITE}/checkout-s/${COMPANY}?membership=${COMPANY}`],
    ],
    shop: [
      ['Cartes de cours', `${STUDIO}/pass/?tabSelected=1&index=1&hidePrivatePass=true&hidePaymentCombo=true&paymentPackCategories=3899,3898,3895,3894&privatePassCategories=`],
      ['Abonnements annuels', `${STUDIO}/subscription/?tabSelected=2&index=2`],
      ['Abonnements mensuels', `${STUDIO}/pass/?tabSelected=3&index=3&hidePaymentPack=false&hidePrivatePass=true&hidePaymentCombo=true&paymentPackCategories=3896&privatePassCategories=`],
      ['Packs de cours', `${STUDIO}/pass/?tabSelected=6&index=6&hidePaymentPack=true&hidePrivatePass=true&paymentPackCategories=&privatePassCategories=`],
      ['Carte cadeau', `${STUDIO}/giftcard/?tabSelected=4&index=4&giftcards=2639,17749,2638`],
      ['Magasin', `${STUDIO}/shop/?tabSelected=3&index=3`],
    ],
    planning: `${STUDIO}/calendar/?tabSelected=0&index=0`,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Familles d'activité — une couleur par famille, sur la tranche des cartes et
  // dans les filtres. Par libellé faute de catégorie dans l'API ; un cours
  // inconnu tombe dans « autre », sans casse.
  // ─────────────────────────────────────────────────────────────────────────

  const FAMILIES = [
    { id: 'pole',  re: /pole|chor[ée]/i },
    { id: 'air',   re: /cerceau|tissu|hamac|a[ée]rien/i },
    { id: 'body',  re: /pr[ée]pa|flex|souplesse|stretch|renfo/i },
  ];
  const familyOf = (name) => FAMILIES.find((f) => f.re.test(name))?.id ?? 'other';

  // ─────────────────────────────────────────────────────────────────────────
  // Dates — clés 'YYYY-MM-DD' dans le fuseau du studio. L'arithmétique de jours
  // se fait à midi UTC pour ne pas sauter de jour au changement d'heure.
  // ─────────────────────────────────────────────────────────────────────────

  const F_KEY   = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const F_TIME  = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const F_WDAY  = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short' });
  const F_LONG  = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const F_DM    = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  const F_OPEN  = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

  const dayKey = (d) => F_KEY.format(d);
  const noon = (key) => new Date(`${key}T12:00:00Z`);
  const addDays = (key, n) => new Date(noon(key).getTime() + n * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((noon(b) - noon(a)) / 86400000);
  const mondayOf = (key) => addDays(key, -((noon(key).getUTCDay() + 6) % 7));

  /** 'HH:MM' lu champ par champ : selon ICU, le format complet peut rendre « 18 h 30 ». */
  function hm(d) {
    const p = F_TIME.formatToParts(d);
    const get = (t) => p.find((x) => x.type === t)?.value ?? '00';
    return `${get('hour')}:${get('minute')}`;
  }

  function relativeDay(n) {
    if (n === 0) return "aujourd'hui";
    if (n === 1) return 'demain';
    if (n === -1) return 'hier';
    return n > 0 ? `dans ${n} j` : '';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Jeton — stocké sur cet appareil uniquement. Le mot de passe, lui, n'est
  // jamais conservé : il part vers bsport et c'est tout.
  // ─────────────────────────────────────────────────────────────────────────

  const TOKEN_RE = /^[0-9a-f]{40}$/i;

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* stockage bloqué */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* idem */ } },
  };

  let token = TOKEN_RE.test(storage.get(TOKEN_KEY) ?? '') ? storage.get(TOKEN_KEY) : null;

  function setToken(value) {
    token = value;
    if (value) storage.set(TOKEN_KEY, value); else storage.remove(TOKEN_KEY);
  }

  /**
   * Pont de secours : `…/#token=<clé>` (fragment jamais envoyé au serveur).
   * Sert si leur endpoint de connexion change ou se met à exiger un captcha.
   * Un lien reçu pourrait imposer le compte de quelqu'un d'autre : jamais par
   * dessus une session existante, et seulement après confirmation.
   */
  (function takeTokenFromHash() {
    const m = location.hash.match(/^#token=([0-9a-f]{40})$/i);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (token) return;
    if (confirm('Ce lien contient une clé de session bsport. L’utiliser pour se connecter sur cet appareil ?')) setToken(m[1]);
  })();

  /**
   * La réponse de connexion n'a pas été lue (elle contient le jeton) : on
   * cherche d'abord une clé dont le nom évoque un jeton, puis n'importe quelle
   * valeur hex de 40 caractères.
   */
  function findToken(json) {
    const values = [];
    const walk = (node, key = '') => {
      if (typeof node === 'string') values.push([key, node.trim()]);
      else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k);
    };
    walk(json);
    const named = values.find(([k, v]) => /token|key/i.test(k) && TOKEN_RE.test(v));
    return (named ?? values.find(([, v]) => TOKEN_RE.test(v)))?.[1] ?? null;
  }

  async function signIn(email, password) {
    let res;
    try {
      res = await fetch(`${API}/platform/v1/authentication/signin/with-login/`, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Bsport-Company-Id': String(COMPANY),
          'X-Timezone-Name': TZ,
        },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new Error('Pas de connexion réseau. Vérifie ta connexion et réessaie.');
    }
    if ([400, 401, 403].includes(res.status)) throw new Error('Email ou mot de passe incorrect.');
    if (!res.ok) throw new Error(`bsport a répondu ${res.status}. Réessaie dans un moment.`);
    const found = findToken(await res.json().catch(() => null));
    if (!found) throw new Error("Connexion acceptée, mais bsport n'a pas renvoyé de clé de session lisible.");
    return found;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accès API
  //
  // Par ouverture : 3 requêtes de référence (coachs, salles, niveaux), 3 de plus
  // si connecté (réservations, crédits, profil), puis 1 par semaine affichée.
  // Tout reste en mémoire : revenir sur une semaine déjà vue ne refait pas d'appel.
  // ─────────────────────────────────────────────────────────────────────────

  async function get(path, params = {}, { auth = false } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // Le jeton n'accompagne que les appels qui en ont besoin : un jeton périmé
    // ferait échouer jusqu'aux endpoints publics.
    const res = await fetch(url, {
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        'X-Timezone-Name': TZ,
        ...(auth && token ? { Authorization: `Token ${token}` } : {}),
      },
    });
    if (!res.ok) throw Object.assign(new Error(`${res.status} sur ${path}`), { status: res.status });
    return res.json();
  }

  const asList = (json) => (Array.isArray(json) ? json : json?.results ?? []);

  /** Pour les appels secondaires : un échec ne doit pas empêcher le planning de s'afficher. */
  const optional = (promise, label) =>
    promise.catch((err) => { console.warn(`[planning] ${label} indisponible`, err); return null; });

  let refData = null;
  let account = null;             // { registered: Set, credits, name, photo } si connecté
  let accountLoaded = false;
  const weeks = new Map();        // lundi 'YYYY-MM-DD' → offers[]
  let fetchedAt = 0;

  async function loadReferenceData() {
    const [coaches, rooms, levels] = await Promise.all([
      get('/book/v1/coach/', { company: COMPANY, page_size: 'null' }),
      get('/book/v1/establishment/', { company: COMPANY, page_size: 'null' }),
      get('/core-data/v1/master-data/level/', { company: COMPANY, page_size: 'null' }),
    ]);
    return {
      coaches: new Map(asList(coaches).map((c) => [c.id, c])),
      rooms: new Map(asList(rooms).map((r) => [r.id, r])),
      levels: new Map(asList(levels).map((l) => [l.id, l])),
    };
  }

  /**
   * Le format de /member/me/ n'a pas été observé connecté : on essaie les champs
   * plausibles et on retombe sur une icône si aucun ne répond.
   */
  function memberName(me) {
    const u = me?.user ?? me ?? {};
    const first = (u.first_name ?? u.firstname ?? '').trim();
    const last = (u.last_name ?? u.lastname ?? '').trim();
    const full = (u.name ?? `${first} ${last}`).trim();
    return full || null;
  }

  /** Crédits restants sur les packs encore valides, avec la première échéance. */
  function summarizeCredits(packs, today) {
    const live = asList(packs).filter((p) => !p.disabled && !p.reverted && (!p.ending_date || p.ending_date >= today));
    if (live.length === 0) return null;
    const total = live.reduce((n, p) => n + (p.available_credits ?? 0), 0);
    const ends = live.map((p) => p.ending_date).filter(Boolean).sort();
    return { total, endsOn: ends[0] ?? null };
  }

  async function loadAccount() {
    if (!token) return null;
    let registered;
    try {
      registered = await get('/book/v1/offer/registered/', {}, { auth: true });
    } catch (err) {
      // Jeton révoqué (déconnexion ailleurs, changement de mot de passe…) : on
      // l'oublie et on le dit, plutôt que d'afficher un planning sans réservations.
      if (err.status === 401 || err.status === 403) {
        setToken(null);
        notice = 'expired';
      } else {
        console.warn('[planning] réservations indisponibles', err);
      }
      return null;
    }
    const [packs, me] = await Promise.all([
      optional(get('/buyable/v1/payment-pack/consumer-payment-pack/compatible_with_offer_unfiltered/', { mine: 'true' }, { auth: true }), 'crédits'),
      optional(get('/customer-data-platform/v1/member/me/', {}, { auth: true }), 'profil'),
    ]);
    return {
      registered: new Set(asList(registered)),
      credits: packs ? summarizeCredits(packs, dayKey(new Date())) : null,
      name: memberName(me),
      photo: me?.user?.photo ?? me?.photo ?? null,
    };
  }

  /**
   * with_booking_window=true ajoute booking_window_status et ses bornes : plus
   * besoin de recalculer la fenêtre J-28 depuis le meta_activity. max_date est
   * inclusif (vérifié sur leur propre appel).
   */
  async function loadWeek(monday) {
    if (weeks.has(monday)) return weeks.get(monday);
    const json = await get('/book/v1/offer/', {
      company: COMPANY,
      min_date: monday,
      max_date: addDays(monday, 6),
      only_future_strict: 'false',
      with_tags: 'true',
      with_booking_window: 'true',
    });
    const offers = asList(json);
    weeks.set(monday, offers);
    fetchedAt = Date.now();
    return offers;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mise en forme des données
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * « Florence RENAUT » → « Florence Renaut ». Seuil à 3 lettres pour laisser
   * les initiales (« JP ») intactes. Les noms vides (« ») donnent null.
   */
  function coachName(coach) {
    const raw = coach?.user?.name?.trim();
    if (!raw) return null;
    return raw.replace(/\p{Lu}{3,}/gu, (w) => w[0] + w.slice(1).toLowerCase());
  }

  function roomName(room) {
    const t = room?.title ?? '';
    if (/fives/i.test(t)) return 'Fives';
    if (/sous.?sol/i.test(t)) return 'Jaurès, sous-sol';
    if (/jaur/i.test(t)) return 'Jaurès';
    return t.replace(/\s+/g, ' ').trim() || 'Salle inconnue';
  }

  const siteOf = (room) => (/fives/i.test(room?.title ?? '') ? 'Fives' : /jaur/i.test(room?.title ?? '') ? 'Jaurès' : 'Autre');

  /**
   * « Préparation physique  Abonnement » et « Préparation physique » sont le même
   * créneau, l'un inclus dans l'abonnement, l'autre payé en crédits. On les range
   * sous le même nom de filtre et c'est l'étiquette de prix qui les distingue.
   */
  function shape(o, now) {
    const start = new Date(o.date_start);
    const end = new Date(start.getTime() + (o.duration_minute ?? 0) * 60000);
    const rawName = (o.name_override || o.activity_name || 'Cours').replace(/\s+/g, ' ').trim();
    const subscription = /\babonnement$/i.test(rawName);
    const name = rawName.replace(/\s*\babonnement$/i, '');
    const room = refData.rooms.get(o.establishment_override ?? o.establishment);
    const coach = refData.coaches.get(o.coach_override ?? o.coach);
    const level = refData.levels.get(o.custom_level ?? o.level);
    const mine = account?.registered.has(o.id) ?? false;

    let state;
    if (end <= now) state = 'past';
    else if (start <= now) state = 'ongoing';
    else if (mine) state = 'booked';
    else if (o.booking_window_status && o.booking_window_status !== 'open') state = 'closed';
    else if (o.full) state = 'full';
    else state = 'open';

    const capacity = o.effectif ?? 0;
    return {
      id: o.id,
      day: dayKey(start),
      start, end, name, subscription, state, mine,
      family: familyOf(name),
      price: o.credit_price_override ?? o.credit_price ?? 0,
      waitlist: o.full && !o.waiting_list_disabled && (o.waiting_list_max_size ?? 0) > 0 && !o.is_waiting_list_full,
      opensAt: o.booking_window_start_datetime ? new Date(o.booking_window_start_datetime) : null,
      capacity,
      left: Math.max(capacity - (o.validated_booking_count ?? 0), 0),
      level: level?.name?.trim() || null,
      coach: coachName(coach),
      room: roomName(room),
      site: siteOf(room),
    };
  }

  function statusText(c) {
    switch (c.state) {
      case 'past': return 'Terminé';
      case 'ongoing': return 'En cours';
      case 'booked': return 'Réservé';
      case 'closed':
        return c.opensAt && c.opensAt > Date.now()
          ? `Ouvre le ${F_OPEN.format(c.opensAt)}`
          : 'Réservations closes';
      case 'full': return c.waitlist ? "Liste d'attente" : 'Complet';
      default:
        if (!c.capacity) return 'Places libres';
        return c.left === 1 ? 'Dernière place' : `${c.left} places`;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Filtres — mémorisés sur l'appareil, avec repli silencieux.
  // ─────────────────────────────────────────────────────────────────────────

  const filters = (() => {
    const base = { acts: [], site: 'all', mine: false };
    try {
      return { ...base, ...JSON.parse(storage.get(STORE_KEY) ?? '{}') };
    } catch {
      return base;
    }
  })();

  const saveFilters = () => storage.set(STORE_KEY, JSON.stringify(filters));

  const keep = (c) =>
    (filters.acts.length === 0 || filters.acts.includes(c.name)) &&
    (filters.site === 'all' || filters.site === c.site) &&
    (!filters.mine || c.mine);

  const hasFilters = () => filters.acts.length > 0 || filters.site !== 'all' || filters.mine;

  // ─────────────────────────────────────────────────────────────────────────
  // Rendu
  // ─────────────────────────────────────────────────────────────────────────

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    for (const k of kids.flat()) if (k) n.append(k);
    return n;
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    bar: $('bar'), week: $('week'), weekLabel: $('week-label'),
    prev: $('prev'), current: $('current'), next: $('next'),
    credits: $('credits'), avatar: $('avatar'), menu: $('menu'),
    filters: $('filters'), board: $('board'),
    login: $('login'), loginForm: $('login-form'), loginError: $('login-error'),
    loginSubmit: $('login-submit'), loginCancel: $('login-cancel'),
  };

  const PERSON_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';

  /** Une barre par place, jusqu'à 20 ; au-delà la rangée ne se lit plus, le texte suffit. */
  function renderPips(c) {
    if (!c.capacity || c.capacity > 20 || c.state === 'past') return null;
    const row = el('div', { className: 'pips' });
    row.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < c.capacity; i++) {
      row.append(el('span', { className: `pip${i < c.left ? ' free' : ''}` }));
    }
    return row;
  }

  function renderCard(c) {
    const isLink = c.state !== 'past';
    const low = c.state === 'open' && c.capacity && c.left <= 2;
    const card = el(isLink ? 'a' : 'div', { className: `card fam-${c.family} ${c.state}${low ? ' low' : ''}` },
      el('div', { className: 'top' },
        el('span', { className: 'time', textContent: hm(c.start) }),
        el('span', { className: 'end', textContent: `– ${hm(c.end)}` }),
      ),
      el('div', { className: 'name', textContent: c.name }),
      c.level ? el('div', { className: 'meta', textContent: c.level }) : null,
      el('div', { className: 'meta', textContent: [c.coach, c.room].filter(Boolean).join(', ') }),
      renderPips(c),
      el('div', { className: 'foot' },
        el('span', { className: 'status', textContent: statusText(c) }),
        el('span', {
          className: `price${c.subscription ? ' sub' : ''}`,
          textContent: c.subscription ? 'Abonnement' : c.price ? `${c.price} cr.` : 'Gratuit',
          title: c.subscription ? "Inclus dans l'abonnement, ne consomme pas de crédit" : `${c.price} crédit(s)`,
        }),
      ),
    );
    if (isLink) {
      // Nouvel onglet : depuis l'app installée, la page bsport s'ouvre par-dessus
      // et on retombe sur le planning en la fermant.
      Object.assign(card, { href: BOOKING_URL(c.id), target: '_blank', rel: 'noopener' });
      card.setAttribute('aria-label',
        `${c.name}${c.subscription ? ' (abonnement)' : ''}, ${F_LONG.format(noon(c.day))} de ${hm(c.start)} à ${hm(c.end)}, ${c.room}. ${statusText(c)}.`);
    }
    return card;
  }

  function renderDay(key, courses, now) {
    const n = daysBetween(dayKey(now), key);
    const day = el('section', { className: `day${n === 0 ? ' today' : ''}${n < 0 ? ' past' : ''}` },
      el('div', { className: 'day-head' },
        el('span', { className: 'day-num', textContent: String(noon(key).getUTCDate()) }),
        el('span', { className: 'day-name', textContent: F_WDAY.format(noon(key)).replace('.', '') }),
        el('span', { className: 'day-rel', textContent: relativeDay(n) }),
      ),
    );
    day.setAttribute('aria-label', F_LONG.format(noon(key)));

    const list = el('div', { className: 'list' });
    if (courses.length === 0) list.append(el('div', { className: 'none', textContent: 'Aucun cours' }));

    let nowPlaced = n !== 0;
    for (const c of courses) {
      if (!nowPlaced && c.start > now) {
        list.append(el('div', { className: 'now', textContent: hm(now) }));
        nowPlaced = true;
      }
      list.append(renderCard(c));
    }
    if (!nowPlaced && courses.length) list.append(el('div', { className: 'now', textContent: hm(now) }));

    day.append(list);
    return day;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Application
  // ─────────────────────────────────────────────────────────────────────────

  const state = {
    monday: mondayOf(dayKey(new Date())),
    status: 'idle',   // idle | loading | ready | error
    error: null,
  };
  let notice = null;   // 'expired' : jeton refusé, à reconnecter

  function go(delta) {
    state.monday = addDays(state.monday, delta * 7);
    load();
    window.scrollTo({ top: 0 });
  }

  async function load() {
    const monday = state.monday;
    state.status = weeks.has(monday) && refData ? 'ready' : 'loading';
    paint();
    if (state.status === 'ready') return;
    try {
      const [ref, acc] = await Promise.all([
        refData ?? loadReferenceData(),
        accountLoaded ? account : loadAccount(),
        loadWeek(monday),
      ]);
      refData = ref;
      account = acc;
      accountLoaded = true;
      if (state.monday !== monday) return;   // l'utilisateur a changé de semaine entre-temps
      state.status = 'ready';
    } catch (err) {
      console.error('[planning]', err);
      state.status = 'error';
      state.error = err;
    }
    paint();
  }

  /** Oublie tout ce qui est en mémoire et recharge — pour voir une réservation tout juste faite. */
  function refresh() {
    weeks.clear();
    accountLoaded = false;
    load();
  }

  function paint() {
    const now = new Date();
    const thisMonday = mondayOf(dayKey(now));

    ui.current.disabled = state.monday === thisMonday;
    ui.prev.disabled = state.monday <= thisMonday;   // le passé ne se réserve pas
    paintAccount();
    paintWeek(now);
    paintNotice();

    if (state.status === 'loading') {
      ui.filters.replaceChildren();
      ui.board.replaceChildren(el('div', { className: 'msg', textContent: 'Chargement de la semaine…' }));
      return;
    }
    if (state.status === 'error') {
      const retry = el('button', { type: 'button', textContent: 'Réessayer' });
      retry.addEventListener('click', () => load());
      const offline = navigator.onLine === false;
      ui.filters.replaceChildren();
      ui.board.replaceChildren(el('div', { className: 'msg' },
        el('div', {
          textContent: offline
            ? 'Pas de connexion réseau : le planning ne peut pas être chargé.'
            : `Le planning n'a pas pu être chargé (${state.error?.message ?? 'erreur inconnue'}).`,
        }),
        retry,
      ));
      return;
    }

    const all = (weeks.get(state.monday) ?? [])
      .filter((o) => o.available !== false || account?.registered.has(o.id))
      .map((o) => shape(o, now))
      .sort((a, b) => a.start - b.start);

    paintFilters(all);

    const shown = all.filter(keep);
    if (shown.length === 0 && all.length > 0) {
      const reset = el('button', { type: 'button', textContent: 'Retirer les filtres' });
      reset.addEventListener('click', clearFilters);
      ui.board.replaceChildren(el('div', { className: 'msg' },
        el('div', { textContent: 'Aucun cours ne correspond aux filtres cette semaine.' }), reset));
      return;
    }

    const byDay = new Map();
    for (let i = 0; i < 7; i++) byDay.set(addDays(state.monday, i), []);
    for (const c of shown) byDay.get(c.day)?.push(c);
    ui.board.replaceChildren(...[...byDay].map(([key, courses]) => renderDay(key, courses, now)));
  }

  /** Titre de la semaine, avec sa position relative : « la semaine prochaine », « dans 3 semaines ». */
  function paintWeek(now) {
    const offset = daysBetween(mondayOf(dayKey(now)), state.monday) / 7;
    const sunday = addDays(state.monday, 6);
    // « 2 – 8 nov. » quand le mois ne change pas : la barre est étroite sur téléphone.
    const from = state.monday.slice(0, 7) === sunday.slice(0, 7)
      ? String(noon(state.monday).getUTCDate())
      : F_DM.format(noon(state.monday));
    ui.week.textContent = `${from} – ${F_DM.format(noon(sunday))}`;
    ui.weekLabel.textContent = offset === 0 ? 'cette semaine' : offset === 1 ? 'la semaine prochaine' : `dans ${offset} semaines`;
    ui.weekLabel.title = offset >= 4 ? 'Les réservations ouvrent 4 semaines avant le cours.' : '';
  }

  function paintNotice() {
    document.querySelector('.notice')?.remove();
    if (notice !== 'expired') return;
    const again = el('button', { type: 'button', textContent: 'Se reconnecter' });
    again.addEventListener('click', openLogin);
    ui.filters.before(el('div', { className: 'notice', role: 'status' },
      el('span', { textContent: 'Ta session bsport a expiré : tes réservations ne sont plus affichées.' }),
      again,
    ));
  }

  function paintAccount() {
    const c = account?.credits;
    ui.credits.hidden = !c;
    if (c) {
      ui.credits.className = `credits${c.total <= 0 ? ' empty' : ''}`;
      ui.credits.title = creditsSentence();
      ui.credits.replaceChildren(el('b', { textContent: String(c.total) }), el('span', { textContent: 'crédits' }));
    }
    if (account?.photo) {
      if (!ui.avatar.querySelector('img')) ui.avatar.replaceChildren(el('img', { src: account.photo, alt: '' }));
    } else if (account?.name) {
      ui.avatar.textContent = initials(account.name);
    } else {
      ui.avatar.innerHTML = PERSON_ICON;
    }
  }

  function chip(text, pressed, onClick, family) {
    const b = el('button', { type: 'button', className: `chip${family ? ` fam-${family}` : ''}` },
      family ? el('span', { className: 'dot' }) : null, text);
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', () => { onClick(); saveFilters(); paint(); });
    return b;
  }

  function clearFilters() {
    filters.acts = [];
    filters.site = 'all';
    filters.mine = false;
    saveFilters();
    paint();
  }

  function paintFilters(all) {
    // Activités de la semaine, plus celles déjà cochées : un filtre actif ne
    // doit pas disparaître parce que la semaine n'en contient pas. Rangées par
    // famille, comme les couleurs qui les accompagnent.
    const order = ['pole', 'air', 'body', 'other'];
    const names = [...new Set([...all.map((c) => c.name), ...filters.acts])]
      .sort((a, b) => order.indexOf(familyOf(a)) - order.indexOf(familyOf(b)) || a.localeCompare(b, 'fr'));

    const acts = el('div', { className: 'group', role: 'group', ariaLabel: 'Activités' },
      ...names.map((name) => chip(name, filters.acts.includes(name), () => {
        const i = filters.acts.indexOf(name);
        if (i >= 0) filters.acts.splice(i, 1); else filters.acts.push(name);
      }, familyOf(name))),
    );

    const sites = el('div', { className: 'group', role: 'group', ariaLabel: 'Studio' },
      ...[['all', 'Tous les studios'], ['Jaurès', 'Jaurès'], ['Fives', 'Fives']].map(([value, label]) =>
        chip(label, filters.site === value, () => { filters.site = value; })),
    );

    const parts = [sites, el('div', { className: 'sep' }), acts];
    if (account) {
      parts.unshift(chip('Mes réservations', filters.mine, () => { filters.mine = !filters.mine; }), el('div', { className: 'sep' }));
    }
    if (hasFilters()) {
      const clear = el('button', { type: 'button', className: 'clear', textContent: 'Tout afficher' });
      clear.addEventListener('click', clearFilters);
      parts.push(clear);
    }
    ui.filters.replaceChildren(...parts);
  }

  // ── Menu profil : bouton + liste, au clavier comme au doigt ────────────

  const menuItems = () => [...ui.menu.querySelectorAll('[role="menuitem"]')];

  function openMenu() {
    paintMenu();
    ui.menu.hidden = false;
    ui.avatar.setAttribute('aria-expanded', 'true');
    menuItems()[0]?.focus();
  }

  function closeMenu(refocus) {
    if (ui.menu.hidden) return;
    ui.menu.hidden = true;
    ui.avatar.setAttribute('aria-expanded', 'false');
    if (refocus) ui.avatar.focus();
  }

  ui.avatar.addEventListener('click', () => (ui.menu.hidden ? openMenu() : closeMenu(false)));
  ui.menu.addEventListener('keydown', (e) => {
    const list = menuItems();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list.at(-1)?.focus(); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!ui.avatar.parentElement.contains(e.target)) closeMenu(false);
  });

  function paintMenu() {
    const link = (label, href) =>
      el('a', { className: 'menu-item external', role: 'menuitem', href, target: '_blank', rel: 'noopener', textContent: label });
    const action = (label, run) => {
      const b = el('button', { type: 'button', className: 'menu-item', role: 'menuitem', textContent: label });
      b.addEventListener('click', () => { closeMenu(false); run(); });
      return b;
    };

    const head = account
      ? el('div', { className: 'menu-head' },
          el('div', { className: 'menu-name', textContent: account.name ?? 'Mon compte' }),
          el('div', { className: 'menu-credits', textContent: creditsSentence() }),
        )
      : null;

    ui.menu.replaceChildren(...[
      head,
      el('div', { className: 'menu-group', role: 'group', ariaLabel: 'Mon compte' },
        account
          ? LINKS.account.map(([label, href]) => link(label, href))
          : [action('Se connecter', openLogin), link(...LINKS.account[1])],
      ),
      el('div', { className: 'menu-group', role: 'group', ariaLabel: 'Acheter' },
        el('div', { className: 'menu-label', textContent: 'Acheter' }),
        LINKS.shop.map(([label, href]) => link(label, href)),
      ),
      el('div', { className: 'menu-group' },
        action('Actualiser', refresh),
        link('Planning sur bsport', LINKS.planning),
        account ? action('Se déconnecter de cet appareil', signOut) : null,
      ),
    ].filter(Boolean));
  }

  function creditsSentence() {
    const c = account?.credits;
    if (!c) return 'Solde de crédits indisponible';
    const n = `${c.total} crédit${c.total > 1 ? 's' : ''}`;
    return c.endsOn ? `${n}, valables jusqu'au ${F_DM.format(noon(c.endsOn))}` : n;
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  // ── Connexion ─────────────────────────────────────────────────────────

  function openLogin() {
    ui.loginError.hidden = true;
    ui.loginForm.reset();
    ui.login.showModal();
    ui.loginForm.elements.email.focus();
  }

  ui.loginCancel.addEventListener('click', () => ui.login.close());

  ui.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { email, password } = ui.loginForm.elements;
    if (!email.value.trim() || !password.value) {
      showLoginError('Renseigne ton email et ton mot de passe.');
      return;
    }
    ui.loginSubmit.disabled = true;
    ui.loginSubmit.textContent = 'Connexion…';
    try {
      setToken(await signIn(email.value.trim(), password.value));
      password.value = '';
      notice = null;
      ui.login.close();
      accountLoaded = false;
      account = await loadAccount();
      accountLoaded = true;
      paint();
    } catch (err) {
      showLoginError(err.message);
    } finally {
      ui.loginSubmit.disabled = false;
      ui.loginSubmit.textContent = 'Se connecter';
    }
  });

  function showLoginError(text) {
    ui.loginError.textContent = text;
    ui.loginError.hidden = false;
  }

  /** Oublie la clé sur cet appareil. Elle reste valable chez bsport jusqu'à ce qu'ils la révoquent. */
  function signOut() {
    setToken(null);
    account = null;
    accountLoaded = true;
    if (filters.mine) { filters.mine = false; saveFilters(); }
    paint();
  }

  // ── Câblage général ───────────────────────────────────────────────────

  ui.prev.addEventListener('click', () => go(-1));
  ui.next.addEventListener('click', () => go(1));
  ui.current.addEventListener('click', () => { state.monday = mondayOf(dayKey(new Date())); load(); });

  document.addEventListener('keydown', (e) => {
    if (ui.login.open || !ui.menu.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
    if (e.key === 'ArrowLeft' && !ui.prev.disabled) go(-1);
    if (e.key === 'ArrowRight') go(1);
  });

  // Les en-têtes de jour collent sous la barre, dont la hauteur varie
  // (encoche de l'iPhone, retour à la ligne).
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--bar-h', `${ui.bar.offsetHeight}px`);
  }).observe(ui.bar);

  // Le repère « maintenant » et les états (en cours, terminé) avancent avec
  // l'heure : on repeint depuis la mémoire, sans requête. Au retour sur l'app
  // après un moment, les places ont pu bouger : on recharge.
  setInterval(() => { if (!document.hidden && ui.menu.hidden && state.status === 'ready') paint(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.status === 'loading') return;
    if (Date.now() - fetchedAt > STALE_MS) refresh(); else paint();
  });

  load();
})();
