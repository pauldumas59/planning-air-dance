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
  const VIEW_KEY = 'bsport-planning:view';
  const TOKEN_KEY = 'bsport-planning:token';
  const STALE_MS = 10 * 60000;   // au retour sur l'app après 10 min, on recharge la semaine

  // Relevés dans leur barre de navigation le 2026-10-26. Les paramètres
  // tabSelected/index ne servent qu'à surligner leur onglet actif.
  const STUDIO = `${SITE}/m/Air%20Dance%20Studio/${COMPANY}`;
  const LINKS = {
    account: [
      ['Réservations sur bsport', `${SITE}/c/${COMPANY}/booking/?membership=${COMPANY}`],
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
  // Familles d'activité — rangent les filtres (pole, aérien, corps, autres).
  // Par libellé faute de catégorie dans l'API ; un cours inconnu tombe dans
  // « autre », sans casse.
  // ─────────────────────────────────────────────────────────────────────────

  const FAMILIES = [
    { id: 'pole',  re: /pole|chor[ée]/i },
    { id: 'air',   re: /cerceau|tissu|hamac|a[ée]rien/i },
    { id: 'body',  re: /pr[ée]pa|flex|souplesse|stretch|renfo/i },
  ];
  const familyOf = (name) => FAMILIES.find((f) => f.re.test(name))?.id ?? 'other';

  // ─────────────────────────────────────────────────────────────────────────
  // Cours favoris — la vue de la modale de bsport-mes-cours.user.js (et de sa
  // copie bsport-mes-cours-copine.user.js) : les prochaines occurrences des
  // créneaux habituels, sur FAV_DAYS jours. Listes reprises telles quelles des
  // scripts, choisies d'après le nom du compte connecté (favoritesFor). Même
  // règle que là-bas :
  // meta_activity + jour habituel (0 = dimanche), et salle quand un même
  // meta_activity couvre plusieurs créneaux. Les libellés ne servent qu'à la
  // lecture du code.
  // ─────────────────────────────────────────────────────────────────────────

  const FAV_DAYS = 30;   // horizonDays des scripts
  const JAURES = [4687, 4688];   // rez-de-chaussée et sous-sol
  const FIVES = [4689];

  // bsport-mes-cours.user.js
  const FAV_MINE = [
      { metaActivity: 59193, label: 'Free Pole Abonnement', usualDay: 0 },
      { metaActivity: 59205, label: 'Préparation physique', usualDay: 1 },
      { metaActivity: 58593, label: 'Pole Dance',           usualDay: 2, establishments: JAURES },
      { metaActivity: 58601, label: 'Flexibilité',          usualDay: 2 },
      { metaActivity: 58593, label: 'Pole Dance',           usualDay: 4, establishments: FIVES },
  ];

  // bsport-mes-cours-copine.user.js
  const FAV_COPINE = [
      { metaActivity: 58601, label: 'Flexibilité',          usualDay: 0, establishments: FIVES },
      { metaActivity: 58594, label: 'Cerceau',              usualDay: 0, establishments: FIVES },
      { metaActivity: 58593, label: 'Pole Dance',           usualDay: 0, establishments: FIVES },
      { metaActivity: 59205, label: 'Préparation physique', usualDay: 1 },
      { metaActivity: 58593, label: 'Pole Dance',           usualDay: 2, establishments: JAURES },
      { metaActivity: 58601, label: 'Flexibilité',          usualDay: 2 },
      { metaActivity: 84642, label: 'Pole Dance 1 h',       usualDay: 4 },
      { metaActivity: 58593, label: 'Pole Dance',           usualDay: 4, establishments: FIVES },
      { metaActivity: 58594, label: 'Cerceau',              usualDay: 4, establishments: FIVES },
      { metaActivity: 58596, label: 'Tissus',               usualDay: 5 },
      { metaActivity: 58602, label: 'Choré XO',             usualDay: 5, establishments: FIVES },
  ];

  /**
   * Seuls deux comptes se connectent ici : nom de famille Seme, c'est la liste
   * de bsport-mes-cours.user.js ; tout autre compte, celle de la copie. Sans
   * nom lisible (profil indisponible), pas de liste plutôt qu'une au hasard.
   */
  function favoritesFor(name) {
    if (!name) return null;
    const plain = name.normalize('NFD').replace(/\p{M}/gu, '');
    return /\bseme\b/i.test(plain) ? FAV_MINE : FAV_COPINE;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dates — clés 'YYYY-MM-DD' dans le fuseau du studio. L'arithmétique de jours
  // se fait à midi UTC pour ne pas sauter de jour au changement d'heure.
  // ─────────────────────────────────────────────────────────────────────────

  const F_KEY   = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const F_TIME  = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const F_WDAY  = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long' });
  const F_LONG  = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const F_DM    = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  const F_OPEN  = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  const F_MON   = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', month: 'short' });
  const F_MONTH = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', month: 'long' });

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
    return '';
  }

  /** « 1er », puis « 2 », « 3 »… comme on l'écrit. */
  const ordinal = (key) => {
    const d = noon(key).getUTCDate();
    return d === 1 ? '1er' : String(d);
  };

  /**
   * « 27 octobre – 2 novembre », « 3 – 9 novembre » quand le mois ne change pas.
   * short : mois abrégés, pour la barre sur téléphone ; sep : « au » pour une phrase.
   */
  function weekRangeText(monday, { short = false, sep = ' – ' } = {}) {
    const sunday = addDays(monday, 6);
    const month = (key) => (short ? F_MON : F_MONTH).format(noon(key));
    const from = monday.slice(0, 7) === sunday.slice(0, 7) ? ordinal(monday) : `${ordinal(monday)} ${month(monday)}`;
    return `${from}${sep}${ordinal(sunday)} ${month(sunday)}`;
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
  // si connecté (réservations, crédits, profil), puis 1 par semaine affichée, et
  // 1 à la première ouverture de « Mes réservations ». « Mes cours favoris »
  // lit les semaines à venir avec le même cache que le planning.
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
    const name = memberName(me);
    return {
      registered: new Set(asList(registered)),
      credits: packs ? summarizeCredits(packs, dayKey(new Date())) : null,
      name,
      photo: me?.user?.photo ?? me?.photo ?? null,
      favorites: favoritesFor(name),
    };
  }

  /**
   * with_booking_window=true ajoute booking_window_status et ses bornes : plus
   * besoin de recalculer la fenêtre J-28 depuis le meta_activity. max_date est
   * inclusif (vérifié sur leur propre appel).
   */
  async function loadWeek(monday, { fresh = false } = {}) {
    if (!fresh && weeks.has(monday)) return weeks.get(monday);
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

  /**
   * /offer/registered/ ne donne que des IDs. id__in les résout tous en une
   * requête publique, passés compris, sans filtre de société ni de dates
   * (vérifié le 2026-10-26).
   */
  async function loadBookedOffers() {
    const ids = [...account.registered];
    if (ids.length === 0) return [];
    return asList(await get('/book/v1/offer/', { id__in: ids.join(','), with_booking_window: 'true' }));
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
    const roomId = o.establishment_override ?? o.establishment;
    const room = refData.rooms.get(roomId);
    const coach = refData.coaches.get(o.coach_override ?? o.coach);
    const level = refData.levels.get(o.custom_level ?? o.level);
    const mine = account?.registered.has(o.id) ?? false;
    const weekday = noon(dayKey(start)).getUTCDay();
    const fav = account?.favorites?.some((f) =>
      f.metaActivity === o.meta_activity && f.usualDay === weekday &&
      (!f.establishments || f.establishments.includes(roomId))) ?? false;

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
      start, end, name, subscription, state, mine, fav,
      price: o.credit_price_override ?? o.credit_price ?? 0,
      waitlist: o.full && !o.waiting_list_disabled && (o.waiting_list_max_size ?? 0) > 0 && !o.is_waiting_list_full,
      opensAt: o.booking_window_start_datetime ? new Date(o.booking_window_start_datetime) : null,
      capacity,
      left: Math.max(capacity - (o.validated_booking_count ?? 0), 0),
      level: level?.name?.trim() || null,
      coach: coachName(coach),
      room: roomName(room),
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
      default: return 'Réserver';
    }
  }

  /** Toujours ce qui reste, jamais ce qui est pris : c'était l'ambiguïté des barres. */
  function placesText(c) {
    if (c.left === 0) return 'Aucune place libre';
    return `${c.left} ${c.left === 1 ? 'place libre' : 'places libres'} sur ${c.capacity}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Export agenda — le bouton « Exporter (.ics) » des userscripts : un fichier
  // avec un VEVENT par cours réservé, à importer dans Google Agenda. L'UID
  // reste le même d'un export à l'autre, pour que l'agenda reconnaisse un
  // cours déjà importé au lieu de le dupliquer.
  // ─────────────────────────────────────────────────────────────────────────

  /** `YYYYMMDDTHHMMSSZ` (RFC 5545) : l'instant suffit, pas besoin du fuseau. */
  const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  /** Valeur TEXT (RFC 5545 §3.3.11) : antislash d'abord, sinon les échappements suivants seraient ré-échappés. */
  const icsEscape = (text) => String(text)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  /** Pas de repli des lignes à 75 octets : Google, Apple et Outlook lisent les lignes longues. */
  function buildICS(courses) {
    const stamp = icsDate(new Date());
    const events = courses.flatMap((c) => [
      'BEGIN:VEVENT',
      `UID:bsport-offer-${c.id}@backoffice.bsport.io`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(c.start)}`,
      `DTEND:${icsDate(c.end)}`,
      `SUMMARY:${icsEscape(c.name)}`,
      `LOCATION:${icsEscape(`Air Dance Studio, ${c.room}`)}`,
      `DESCRIPTION:${icsEscape(`${[c.coach, 'réservé via bsport'].filter(Boolean).join(' — ')}\n${BOOKING_URL(c.id)}`)}`,
      'END:VEVENT',
    ]);
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//planning-air-dance//FR',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      ...events,
      'END:VCALENDAR',
    ].join('\r\n');
  }

  /** Téléchargement sans backend. L'URL survit un peu au clic : Safari la lit après coup. */
  function downloadFile(text, filename, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Filtres — mémorisés sur l'appareil, avec repli silencieux.
  // ─────────────────────────────────────────────────────────────────────────

  const filters = (() => {
    const base = { acts: [], mine: false };
    try {
      // site : ancien filtre par studio, retiré ; on l'oublie s'il est mémorisé.
      const { site, ...saved } = JSON.parse(storage.get(STORE_KEY) ?? '{}');
      return { ...base, ...saved };
    } catch {
      return base;
    }
  })();

  const saveFilters = () => storage.set(STORE_KEY, JSON.stringify(filters));

  const keep = (c) =>
    (filters.acts.length === 0 || filters.acts.includes(c.name)) &&
    (!filters.mine || c.mine);

  const hasFilters = () => filters.acts.length > 0 || filters.mine;

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
    back: $('back'), prev: $('prev'), current: $('current'), next: $('next'),
    refresh: $('refresh'), credits: $('credits'), avatar: $('avatar'), menu: $('menu'),
    filters: $('filters'), board: $('board'),
    login: $('login'), loginForm: $('login-form'), loginError: $('login-error'),
    loginSubmit: $('login-submit'), loginCancel: $('login-cancel'),
  };

  const PERSON_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';

  /**
   * Jauge qui se remplit à mesure que le cours se remplit, et le nombre de
   * places libres écrit en toutes lettres à côté. Complet : la jauge pleine et
   * le statut suffisent.
   */
  function renderPlaces(c) {
    if (!c.capacity || !['open', 'booked', 'closed', 'full'].includes(c.state)) return null;
    const fill = el('span');
    fill.style.width = `${Math.round(((c.capacity - c.left) / c.capacity) * 100)}%`;
    const gauge = el('span', { className: 'gauge' }, fill);
    gauge.setAttribute('aria-hidden', 'true');
    // Rouge quand ça presse : deux places ou moins, et au moins la moitié prise
    // (« 2 places libres sur 2 » n'a rien d'urgent).
    const low = c.left <= Math.min(2, c.capacity / 2);
    return el('div', { className: `places${low ? ' low' : ''}` },
      gauge,
      c.state === 'full' ? null : el('span', { className: 'places-text', textContent: placesText(c) }),
    );
  }

  function renderCard(c) {
    const isLink = c.state !== 'past';
    const card = el(isLink ? 'a' : 'div', { className: `card ${c.state}` },
      el('div', { className: 'top' },
        el('span', { className: 'time', textContent: hm(c.start) }),
        el('span', { className: 'end', textContent: `– ${hm(c.end)}` }),
      ),
      el('div', { className: 'head' },
        el('div', { className: 'name', textContent: c.name }),
        c.level ? el('span', { className: 'level', textContent: c.level }) : null,
      ),
      el('div', { className: 'meta', textContent: [c.coach, c.room].filter(Boolean).join(', ') }),
      renderPlaces(c),
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
        `${c.name}${c.subscription ? ' (abonnement)' : ''}, ${F_LONG.format(noon(c.day))} de ${hm(c.start)} à ${hm(c.end)}, ${c.room}. ${statusText(c)}.${c.capacity && ['open', 'booked', 'closed'].includes(c.state) ? ` ${placesText(c)}.` : ''}`);
    }
    return card;
  }

  /**
   * Se lit dans l'ordre : « Dimanche 1er », le chiffre en gros. agenda : les
   * jours se suivent sur plusieurs semaines, le mois s'ajoute derrière.
   */
  function renderDay(key, courses, now, agenda = false) {
    const n = daysBetween(dayKey(now), key);
    const num = ordinal(key);
    const day = el('section', { className: `day${n === 0 ? ' today' : ''}${n < 0 ? ' past' : ''}` },
      el('div', { className: 'day-head' },
        el('span', { className: 'day-name', textContent: F_WDAY.format(noon(key)) }),
        el('span', { className: 'day-num' },
          el('span', {}, num.replace('er', ''), num.endsWith('er') ? el('sup', { textContent: 'er' }) : null)),
        agenda ? el('span', { className: 'day-month', textContent: F_MONTH.format(noon(key)) }) : null,
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

  // Les semaines s'enchaînent au défilement, de la semaine en cours (first) à
  // la dernière chargée (last). Les réservations ouvrent à J-28 ; au-delà de
  // MAX_AHEAD semaines on s'arrête, le planning n'y est plus qu'une ébauche.
  const MAX_AHEAD = 8;
  const thisMonday = () => mondayOf(dayKey(new Date()));
  const maxMonday = () => addDays(thisMonday(), MAX_AHEAD * 7);

  // La vue choisie est mémorisée sur l'appareil : on rouvre l'app là où on
  // l'a laissée. Les vues du compte ne valent que si une session existe.
  const savedView = storage.get(VIEW_KEY);

  const state = {
    view: token && ['mine', 'fav'].includes(savedView) ? savedView : 'week',   // week | mine | fav
    first: thisMonday(),
    last: thisMonday(),
    visible: thisMonday(),   // la semaine sous la barre : titre et boutons
    status: 'idle',     // idle | loading | ready | error
    error: null,
    more: 'idle',       // idle | loading | error : la semaine suivante, en bas de page
    scrollTo: null,     // semaine à amener sous la barre au prochain rendu
  };
  const booked = { status: 'idle', offers: null, error: null };   // vue « Mes réservations »
  const favs = { status: 'idle', error: null };                   // vue « Mes cours favoris »
  const viewStatus = () => ({ mine: booked.status, fav: favs.status })[state.view] ?? state.status;

  /** Fin de l'horizon des favoris, et les lundis qui le couvrent. */
  const favLimit = () => addDays(dayKey(new Date()), FAV_DAYS);
  function favMondays() {
    const out = [];
    for (let m = thisMonday(); m <= favLimit(); m = addDays(m, 7)) out.push(m);
    return out;
  }
  let notice = null;   // 'expired' : jeton refusé, à reconnecter

  function mondays() {
    const out = [];
    for (let m = state.first; m <= state.last; m = addDays(m, 7)) out.push(m);
    return out;
  }

  /** remember : false pour un retour forcé (session expirée), qui n'est pas un choix. */
  function showView(view, { remember = true } = {}) {
    state.view = view;
    if (remember) storage.set(VIEW_KEY, view);
    window.scrollTo({ top: 0 });
    loadView();
  }

  function loadView() {
    if (state.view === 'mine') loadBooked();
    else if (state.view === 'fav') loadFavorites();
    else load();
  }

  /** Semaine précédente ou suivante : on y défile, en la chargeant au besoin. */
  function go(delta) {
    const target = addDays(state.visible, delta * 7);
    if (target < state.first || target > maxMonday()) return;
    state.scrollTo = target;
    if (target > state.last) extend(); else paint();
  }

  async function load() {
    // Ouverte avant minuit dimanche : la semaine en cours a changé.
    const tm = thisMonday();
    if (state.first < tm) {
      state.first = tm;
      if (state.last < tm) state.last = tm;
      if (state.visible < tm) state.visible = tm;
    }
    const range = mondays();
    const key = range.join();
    state.status = range.every((m) => weeks.has(m)) && refData ? 'ready' : 'loading';
    paint();
    if (state.status === 'ready') return;
    try {
      const [ref, acc] = await Promise.all([
        refData ?? loadReferenceData(),
        accountLoaded ? account : loadAccount(),
        ...range.map(loadWeek),
      ]);
      refData = ref;
      account = acc;
      accountLoaded = true;
      if (mondays().join() !== key) return;   // plage changée entre-temps : l'autre appel repeindra
      state.status = 'ready';
    } catch (err) {
      console.error('[planning]', err);
      state.status = 'error';
      state.error = err;
    }
    paint();
  }

  /** Ajoute la semaine suivante en bas : déclenché par le défilement ou par « › ». */
  async function extend() {
    if (state.status !== 'ready' || state.more === 'loading' || state.last >= maxMonday()) return;
    const next = addDays(state.last, 7);
    state.more = 'loading';
    paintMore();
    try {
      await loadWeek(next);
      if (addDays(state.last, 7) === next) state.last = next;
      state.more = 'idle';
      paint();
    } catch (err) {
      console.error('[planning]', err);
      state.more = 'error';
      paintMore();
    }
  }

  /** Oublie tout ce qui est en mémoire et recharge, écran de chargement compris. */
  function refresh() {
    weeks.clear();
    accountLoaded = false;
    booked.status = 'idle';
    state.scrollTo = state.visible;   // le rechargement repart du haut : on revient où on était
    loadView();
  }

  /**
   * Relit les réservations et les semaines affichées sans rien effacer : le
   * tableau reste en place pendant l'appel, puis se met à jour sous les yeux.
   * C'est ce qui sert au retour de bsport, pour voir la séance tout juste réservée.
   */
  let refreshing = null;
  function softRefresh() {
    if (state.view !== 'week' || state.status !== 'ready') { refresh(); return Promise.resolve(); }
    if (refreshing) return refreshing;
    ui.refresh.classList.add('busy');
    refreshing = (async () => {
      const range = mondays();
      try {
        const [acc, ...lists] = await Promise.all([loadAccount(), ...range.map((m) => loadWeek(m, { fresh: true }))]);
        // null avec un jeton encore là = panne passagère : on garde les réservations connues.
        if (acc || !token) account = acc;
        accountLoaded = true;
        booked.status = 'idle';   // « Mes réservations » se relira à la prochaine ouverture
        for (const m of [...weeks.keys()]) if (!range.includes(m)) weeks.delete(m);
        range.forEach((m, i) => weeks.set(m, lists[i]));
        if (notice === 'refresh-failed') notice = null;
      } catch (err) {
        console.error('[planning]', err);
        notice = 'refresh-failed';
      } finally {
        refreshing = null;
        ui.refresh.classList.remove('busy');
      }
      if (state.view === 'week' && state.status === 'ready') paint();
    })();
    return refreshing;
  }

  /** Pas d'appel tant que la vue n'est pas ouverte, puis un seul jusqu'au prochain « Actualiser ». */
  async function loadBooked() {
    if (booked.status === 'ready' || booked.status === 'loading') { paint(); return; }
    booked.status = 'loading';
    paint();
    try {
      // Après « Actualiser », on relit la liste des réservations avant de la résoudre.
      if (!accountLoaded) {
        account = await loadAccount();
        accountLoaded = true;
      }
      if (!account) {   // session expirée entre-temps : retour au planning, le bandeau l'explique
        booked.status = 'idle';
        showView('week', { remember: false });
        return;
      }
      const [offers, ref] = await Promise.all([loadBookedOffers(), refData ?? loadReferenceData()]);
      booked.offers = offers;
      refData = ref;
      fetchedAt = Date.now();
      booked.status = 'ready';
    } catch (err) {
      console.error('[planning]', err);
      booked.status = 'error';
      booked.error = err;
    }
    paint();
  }

  /**
   * Les semaines des 30 prochains jours, prises dans le cache du planning :
   * aucune requête quand elles ont déjà été vues.
   */
  async function loadFavorites() {
    if (favs.status === 'loading') { paint(); return; }
    const range = favMondays();
    favs.status = refData && accountLoaded && range.every((m) => weeks.has(m)) ? 'ready' : 'loading';
    paint();
    if (favs.status === 'ready') return;
    try {
      const [ref, acc] = await Promise.all([
        refData ?? loadReferenceData(),
        accountLoaded ? account : loadAccount(),
        ...range.map((m) => loadWeek(m)),
      ]);
      refData = ref;
      account = acc;
      accountLoaded = true;
      if (!account) {   // déconnecté entre-temps : retour au planning
        favs.status = 'idle';
        showView('week', { remember: false });
        return;
      }
      favs.status = 'ready';
    } catch (err) {
      console.error('[planning]', err);
      favs.status = 'error';
      favs.error = err;
    }
    paint();
  }

  function paint() {
    const now = new Date();
    const agenda = state.view !== 'week';

    ui.back.hidden = !agenda;
    for (const b of [ui.prev, ui.current, ui.next]) b.hidden = agenda;
    ui.board.classList.toggle('agenda', agenda);
    paintAccount();
    paintNotice();
    if (state.view === 'mine') {
      paintBooked(now);
      return;
    }
    if (state.view === 'fav') {
      paintFavorites(now);
      return;
    }
    paintWeek(now);

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

    const perWeek = mondays().map((monday) => [monday, (weeks.get(monday) ?? [])
      .filter((o) => o.available !== false || account?.registered.has(o.id))
      .map((o) => shape(o, now))
      .sort((a, b) => a.start - b.start)]);

    paintFilters(perWeek.flatMap(([, all]) => all));

    // Le contenu au-dessus ne bouge pas : remplacer le tableau garde le défilement.
    ui.more = el('div', { className: 'more' });
    ui.board.replaceChildren(...perWeek.map(([monday, all], i) => renderWeek(monday, all, now, i > 0)), ui.more);
    paintMore();
    moreObserver.disconnect();
    moreObserver.observe(ui.more);

    if (state.scrollTo) {
      scrollToWeek(state.scrollTo);
      state.scrollTo = null;
    }
    trackVisibleWeek();
  }

  /** Une semaine du tableau ; à partir de la deuxième, un séparateur la présente. */
  function renderWeek(monday, all, now, divided) {
    const block = el('div', { className: 'week-block' });
    block.dataset.monday = monday;
    if (divided) {
      block.append(el('div', { className: 'week-divider' },
        el('span', { textContent: `Semaine du ${weekRangeText(monday, { sep: ' au ' })}` })));
    }

    const shown = all.filter(keep);
    if (shown.length === 0 && all.length > 0) {
      const reset = el('button', { type: 'button', textContent: 'Retirer les filtres' });
      reset.addEventListener('click', clearFilters);
      block.append(el('div', { className: 'msg' },
        el('div', { textContent: 'Aucun cours ne correspond aux filtres cette semaine.' }), reset));
      return block;
    }

    const byDay = new Map();
    for (let i = 0; i < 7; i++) byDay.set(addDays(monday, i), []);
    for (const c of shown) byDay.get(c.day)?.push(c);
    block.append(el('div', { className: 'week-grid' },
      ...[...byDay].map(([key, courses]) => renderDay(key, courses, now))));
    return block;
  }

  /** Pied du tableau : guetteur de défilement, chargement, erreur ou fin. */
  function paintMore() {
    if (!ui.more?.isConnected) return;
    if (state.more === 'loading') {
      ui.more.replaceChildren(el('span', { textContent: 'Chargement de la semaine suivante…' }));
    } else if (state.more === 'error') {
      const retry = el('button', { type: 'button', textContent: 'Réessayer' });
      retry.addEventListener('click', () => { state.more = 'idle'; extend(); });
      ui.more.replaceChildren(el('span', { textContent: "La semaine suivante n'a pas pu être chargée." }), retry);
    } else if (state.last >= maxMonday()) {
      ui.more.replaceChildren(el('span', { textContent: `Planning affiché jusqu'au ${F_LONG.format(noon(addDays(state.last, 6)))}.` }));
    } else {
      ui.more.replaceChildren();
    }
  }

  // Le pied entre dans l'écran (avec un peu d'avance) : on ajoute la semaine suivante.
  const moreObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.more === 'idle') extend();
  }, { rootMargin: '0px 0px 400px 0px' });

  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  function scrollToWeek(monday) {
    if (monday === state.first) {
      window.scrollTo({ top: 0, behavior: smooth() });
      return;
    }
    const block = ui.board.querySelector(`.week-block[data-monday="${monday}"]`);
    if (!block) return;
    const top = block.getBoundingClientRect().top + window.scrollY - ui.bar.offsetHeight - 16;
    window.scrollTo({ top, behavior: smooth() });
  }

  /** Quelle semaine passe sous la barre : elle donne le titre et l'état des boutons. */
  function trackVisibleWeek() {
    if (state.view !== 'week' || state.status !== 'ready') return;
    const line = ui.bar.offsetHeight + 80;
    let visible = state.first;
    for (const block of ui.board.querySelectorAll('.week-block')) {
      if (block.getBoundingClientRect().top > line) break;
      visible = block.dataset.monday;
    }
    if (visible === state.visible) return;
    state.visible = visible;
    paintWeek(new Date());
  }

  /** En-tête et tableau vidés pour une vue agenda (réservations, favoris). */
  function startAgenda(title) {
    ui.week.textContent = title;
    ui.weekLabel.textContent = '';
    ui.weekLabel.title = '';
    ui.filters.replaceChildren();
  }

  function message(text, action, onClick) {
    const box = el('div', { className: 'msg' }, el('div', { textContent: text }));
    if (action) {
      const b = el('button', { type: 'button', textContent: action });
      b.addEventListener('click', onClick);
      box.append(b);
    }
    ui.board.replaceChildren(box);
  }

  /** Cours groupés par jour, toutes semaines confondues. */
  function renderAgenda(courses, now) {
    const byDay = new Map();
    for (const c of courses) {
      if (!byDay.has(c.day)) byDay.set(c.day, []);
      byDay.get(c.day).push(c);
    }
    ui.board.replaceChildren(...[...byDay].map(([key, list]) => renderDay(key, list, now, true)));
  }

  /** Réservations à venir, groupées par jour, toutes semaines confondues. */
  function paintBooked(now) {
    startAgenda('Mes réservations');

    if (booked.status === 'loading') {
      message('Chargement de tes réservations…');
      return;
    }
    if (booked.status === 'error') {
      message(navigator.onLine === false
        ? 'Pas de connexion réseau : tes réservations ne peuvent pas être chargées.'
        : `Tes réservations n'ont pas pu être chargées (${booked.error?.message ?? 'erreur inconnue'}).`,
      'Réessayer', loadBooked);
      return;
    }

    const upcoming = (booked.offers ?? [])
      .map((o) => shape(o, now))
      .filter((c) => c.end > now)
      .sort((a, b) => a.start - b.start);

    if (upcoming.length === 0) {
      message('Aucune réservation à venir.', 'Voir le planning', () => showView('week'));
      return;
    }
    ui.weekLabel.textContent = `${upcoming.length} à venir`;
    renderAgenda(upcoming, now);
  }

  /**
   * Prochaines occurrences des créneaux habituels, comme la modale des
   * userscripts : réservées ou non, chacune mène à sa page de réservation.
   */
  function paintFavorites(now) {
    startAgenda('Mes cours favoris');

    if (favs.status === 'loading') {
      message('Chargement de tes cours favoris…');
      return;
    }
    if (favs.status === 'error') {
      message(navigator.onLine === false
        ? 'Pas de connexion réseau : tes cours favoris ne peuvent pas être chargés.'
        : `Tes cours favoris n'ont pas pu être chargés (${favs.error?.message ?? 'erreur inconnue'}).`,
      'Réessayer', loadFavorites);
      return;
    }
    if (!account.favorites) {
      message("Tes cours favoris sont indisponibles : bsport n'a pas renvoyé le nom du compte.", 'Réessayer', refresh);
      return;
    }

    const limit = favLimit();
    const upcoming = favMondays()
      .flatMap((m) => weeks.get(m) ?? [])
      .filter((o) => o.available !== false || account?.registered.has(o.id))
      .map((o) => shape(o, now))
      .filter((c) => c.fav && c.end > now && c.day <= limit)
      .sort((a, b) => a.start - b.start);

    if (upcoming.length === 0) {
      message(`Aucun de tes cours habituels d'ici le ${F_LONG.format(noon(limit))}.`, 'Voir le planning', () => showView('week'));
      return;
    }
    ui.weekLabel.textContent = `jusqu'au ${F_DM.format(noon(limit))}`;
    paintExport(upcoming.filter((c) => c.mine));
    renderAgenda(upcoming, now);
  }

  /** Au-dessus de l'agenda des favoris : les cours réservés partent dans un .ics. */
  function paintExport(courses) {
    const n = courses.length;
    const b = el('button', {
      type: 'button',
      className: 'chip',
      textContent: 'Exporter vers l’agenda (.ics)',
      title: n
        ? 'Télécharge un fichier .ics de tes cours réservés, à importer dans Google Agenda'
        : 'Aucun cours réservé pour l’instant',
      disabled: n === 0,
    });
    b.addEventListener('click', () =>
      downloadFile(buildICS(courses), `air-dance-reservations-${dayKey(new Date())}.ics`, 'text/calendar;charset=utf-8'));
    ui.filters.replaceChildren(el('div', { className: 'agenda-tools' },
      el('span', { textContent: n ? `${n} cours réservé${n > 1 ? 's' : ''}` : 'Aucun cours réservé' }), b));
  }

  /**
   * Titre de la semaine visible, avec sa position relative : « la semaine
   * prochaine », « dans 3 semaines ». Mois en toutes lettres, abrégés sur
   * téléphone (le CSS choisit).
   */
  function paintWeek(now) {
    const monday = state.visible;
    const tm = mondayOf(dayKey(now));
    const offset = daysBetween(tm, monday) / 7;
    ui.week.replaceChildren(
      el('span', { className: 'long', textContent: weekRangeText(monday) }),
      el('span', { className: 'short', textContent: weekRangeText(monday, { short: true }) }),
    );
    ui.weekLabel.textContent = offset === 0 ? 'cette semaine' : offset === 1 ? 'la semaine prochaine' : `dans ${offset} semaines`;
    ui.weekLabel.title = offset >= 4 ? 'Les réservations ouvrent 4 semaines avant le cours.' : '';
    ui.current.disabled = monday === tm;
    ui.prev.disabled = monday <= tm;   // le passé ne se réserve pas
    ui.next.disabled = monday >= maxMonday();
  }

  function paintNotice() {
    document.querySelector('.notice')?.remove();
    const NOTICES = {
      expired: ['Ta session bsport a expiré : tes réservations ne sont plus affichées.', 'Se reconnecter', openLogin],
      'refresh-failed': ["Le planning n'a pas pu être actualisé : il peut dater un peu.", 'Réessayer', softRefresh],
    };
    if (!NOTICES[notice]) return;
    const [text, action, run] = NOTICES[notice];
    const button = el('button', { type: 'button', textContent: action });
    button.addEventListener('click', run);
    ui.filters.before(el('div', { className: 'notice', role: 'status' }, el('span', { textContent: text }), button));
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

  function chip(text, pressed, onClick) {
    const b = el('button', { type: 'button', className: 'chip', textContent: text });
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', () => { onClick(); saveFilters(); paint(); });
    return b;
  }

  /** options : [valeur, libellé]. Le style passe par le label, la flèche par son ::after. */
  function select(label, options, value, onChange) {
    const s = el('select', { ariaLabel: label },
      ...options.map(([v, text]) => el('option', { value: v, textContent: text })));
    s.value = value;
    s.addEventListener('change', () => { onChange(s.value); saveFilters(); paint(); });
    return el('label', { className: `select${options[0][0] === value ? '' : ' active'}` }, s);
  }

  function clearFilters() {
    filters.acts = [];
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

    const mine = () => chip('Mes réservations', filters.mine, () => { filters.mine = !filters.mine; });
    // Pas un filtre : ouvre la vue, d'où pas d'aria-pressed.
    const favorites = () => {
      const b = el('button', { type: 'button', className: 'chip', textContent: 'Mes cours favoris' });
      b.addEventListener('click', () => showView('fav'));
      return b;
    };
    const clear = () => {
      const b = el('button', { type: 'button', className: 'clear', textContent: 'Tout afficher' });
      b.addEventListener('click', clearFilters);
      return b;
    };

    // Grand écran : des puces, plusieurs activités cochables à la fois.
    const wide = [
      el('div', { className: 'group', role: 'group', ariaLabel: 'Activités' },
        ...names.map((name) => chip(name, filters.acts.includes(name), () => {
          const i = filters.acts.indexOf(name);
          if (i >= 0) filters.acts.splice(i, 1); else filters.acts.push(name);
        }))),
    ];
    if (account) wide.unshift(mine(), favorites(), el('div', { className: 'sep' }));
    if (hasFilters()) wide.push(clear());

    // Téléphone : une liste déroulante, une activité à la fois. Une sélection
    // multiple faite sur grand écran reste affichée telle quelle.
    const MULTI = '\u0000multi';
    const actOptions = [['', 'Toutes activités'], ...names.map((n) => [n, n])];
    if (filters.acts.length > 1) actOptions.push([MULTI, `${filters.acts.length} activités`]);
    const narrow = [
      select('Activité', actOptions, filters.acts.length > 1 ? MULTI : filters.acts[0] ?? '', (v) => {
        if (v !== MULTI) filters.acts = v ? [v] : [];
      }),
    ];
    if (account || hasFilters()) {
      narrow.push(el('div', { className: 'filters-extra' }, account ? [mine(), favorites()] : null, hasFilters() ? clear() : null));
    }

    ui.filters.replaceChildren(
      el('div', { className: 'filters-wide' }, ...wide),
      el('div', { className: 'filters-narrow' }, ...narrow),
    );
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
          ? [
              // Les vues autres que celle affichée ; les favoris si le compte en a.
              ...[['week', 'Planning de la semaine'], ['mine', 'Mes réservations'], ['fav', 'Mes cours favoris']]
                .filter(([view]) => view !== state.view)
                .map(([view, label]) => action(label, () => showView(view))),
              ...LINKS.account.map(([label, href]) => link(label, href)),
            ]
          : [action('Se connecter', openLogin), link(...LINKS.account[1])],
      ),
      el('div', { className: 'menu-group', role: 'group', ariaLabel: 'Acheter' },
        el('div', { className: 'menu-label', textContent: 'Acheter' }),
        LINKS.shop.map(([label, href]) => link(label, href)),
      ),
      el('div', { className: 'menu-group' },
        action('Actualiser', softRefresh),
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
    state.view = 'week';
    booked.status = 'idle';
    booked.offers = null;
    load();   // la semaine est en mémoire en général : simple repeinte
  }

  // ── Câblage général ───────────────────────────────────────────────────

  ui.prev.addEventListener('click', () => go(-1));
  ui.next.addEventListener('click', () => go(1));
  ui.current.addEventListener('click', () => scrollToWeek(state.first));
  ui.back.addEventListener('click', () => showView('week'));

  document.addEventListener('keydown', (e) => {
    if (ui.login.open || !ui.menu.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
    if (e.key === 'r' || e.key === 'R') { softRefresh(); return; }
    if (state.view !== 'week') {
      if (e.key === 'Escape') showView('week');
      return;
    }
    if (e.key === 'ArrowLeft' && !ui.prev.disabled) go(-1);
    if (e.key === 'ArrowRight' && !ui.next.disabled) go(1);
  });

  let scrollQueued = false;
  window.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; trackVisibleWeek(); });
  }, { passive: true });

  // Les en-têtes de jour collent sous la barre, dont la hauteur varie
  // (encoche de l'iPhone, retour à la ligne).
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--bar-h', `${ui.bar.offsetHeight}px`);
  }).observe(ui.bar);

  ui.refresh.addEventListener('click', () => softRefresh());

  // Le repère « maintenant » et les états (en cours, terminé) avancent avec
  // l'heure : on repeint depuis la mémoire, sans requête.
  setInterval(() => { if (!document.hidden && ui.menu.hidden && viewStatus() === 'ready') paint(); }, 60000);

  // Au retour sur le planning : si on était parti sur bsport (réserver, payer),
  // ou après un moment, les réservations et les places ont pu changer.
  let wentToBsport = false;
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('a[target="_blank"]')) wentToBsport = true;
  });
  function onReturn() {
    if (document.hidden || viewStatus() === 'loading') return;
    if (wentToBsport || Date.now() - fetchedAt > STALE_MS) {
      wentToBsport = false;
      softRefresh();
    } else {
      paint();
    }
  }
  document.addEventListener('visibilitychange', onReturn);
  // Fenêtre à côté plutôt qu'onglet : la page reste visible, seul le focus revient.
  window.addEventListener('focus', () => { if (wentToBsport) onReturn(); });

  loadView();
})();
