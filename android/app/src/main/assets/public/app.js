/* =========================================================================
   SDCQN Suivi — Application de gestion des missions, échantillons & activités
   Persistance : localStorage (navigateur), 100% hors-ligne après installation.
   ========================================================================= */

const STORE_KEY = "sdcqn_v1";

/* ---------------------------------------------------------------------------
   Persistance NATIVE (fichier disque) des paramètres sensibles — clé d'accès
   du serveur et clé de l'IA. Dans l'application de bureau (Electron), ces
   valeurs sont lues/écrites via un vrai fichier sur le disque (beaucoup plus
   fiable que le localStorage du navigateur intégré pour une page chargée en
   local), garantissant qu'elles restent toujours actives après fermeture et
   réouverture. Dans la version web (navigateur classique), on retombe
   simplement sur localStorage.
--------------------------------------------------------------------------- */
function nativeSettingsAvailable(){
  return typeof window !== "undefined" && !!window.sdcqnNative;
}
function nativeLoadSettings(){
  if(!nativeSettingsAvailable()) return null;
  try{ return window.sdcqnNative.getSettingsSync(); }catch(e){ return null; }
}
function nativeSaveSettings(partial){
  if(!nativeSettingsAvailable()) return;
  try{
    const current = window.sdcqnNative.getSettingsSync() || {};
    const merged = Object.assign({}, current, partial);
    // Écriture SYNCHRONE : l'application attend la confirmation que le fichier a bien
    // été écrit sur le disque avant de continuer — garantit qu'aucune clé (accès
    // serveur ou IA) n'est perdue, même si l'utilisateur ferme l'application juste après.
    if(typeof window.sdcqnNative.setSettingsSync === "function"){
      window.sdcqnNative.setSettingsSync(merged);
    } else {
      window.sdcqnNative.setSettings(merged); // repli si ancienne version du pont natif
    }
  }catch(e){ /* silencieux : le repli localStorage reste actif */ }
}

// Équivalent pour l'application Android (Capacitor) : le stockage "Preferences" du système
// (SharedPreferences Android) est nettement plus résistant que le localStorage de la page
// web embarquée, notamment face à un nettoyage du cache par le système. Écriture en second
// plan (asynchrone) à chaque sauvegarde ; relecture au démarrage pour restaurer les clés si
// jamais le localStorage venait à être vidé entre deux ouvertures de l'application.
const ANDROID_PREFS_KEY = "sdcqn_native_settings";
function androidPrefsAvailable(){
  return typeof window !== "undefined" && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
}
function androidSaveSettingsAsync(partial){
  if(!androidPrefsAvailable()) return;
  const Prefs = window.Capacitor.Plugins.Preferences;
  Prefs.get({ key: ANDROID_PREFS_KEY }).then(res=>{
    let current = {};
    try{ current = res && res.value ? JSON.parse(res.value) : {}; }catch(e){}
    const merged = Object.assign({}, current, partial);
    return Prefs.set({ key: ANDROID_PREFS_KEY, value: JSON.stringify(merged) });
  }).catch(()=>{ /* silencieux : le repli localStorage reste actif */ });
}
// Au démarrage, si l'application Android tourne et que le stockage natif contient des clés
// que le localStorage actuel n'a pas (ex. après un nettoyage du cache), on les restaure.
function androidRestoreSettingsAsync(){
  if(!androidPrefsAvailable()) return;
  window.Capacitor.Plugins.Preferences.get({ key: ANDROID_PREFS_KEY }).then(res=>{
    if(!res || !res.value) return;
    let saved = {};
    try{ saved = JSON.parse(res.value); }catch(e){ return; }
    let changed = false;
    if(saved.aiCfg && saved.aiCfg.apiKey && !aiCfg.apiKey){ aiCfg = Object.assign(aiCfg, saved.aiCfg); changed = true; }
    if(saved.syncCfg && saved.syncCfg.url && !syncCfg.url){ syncCfg = Object.assign(syncCfg, saved.syncCfg); changed = true; }
    if(changed){
      localStorage.setItem(AI_CFG_KEY, JSON.stringify(aiCfg));
      localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(syncCfg));
      updateAiUI(); updateSyncUI();
      if(syncCfg.enabled && syncCfg.url){ startSyncPolling(); pullStateFromServer(false); }
      toast("Clés d'accès restaurées depuis la mémoire sécurisée de l'appareil.");
    }
  }).catch(()=>{});
}

const DEFAULT_SECTEURS = [
  "Agroalimentaire", "Cosmétique", "Matériaux de construction",
  "Produits pétroliers", "Textile & habillement", "Produits chimiques",
  "Boissons", "Autre"
];

const MOIS_FR = ["Jan","Fév","Mar","Avr","Mai","Jun","Jul","Aoû","Sep","Oct","Nov","Déc"];

function uid(prefix){
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){ console.error("Lecture des données impossible", e); }
  return { missions: [], echantillons: [], activites: [], secteurs: DEFAULT_SECTEURS.slice() };
}

function saveState(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }catch(e){
    console.error("Échec de l'enregistrement local", e);
    toast("⚠️ Échec de l'enregistrement local (espace de stockage plein ?). Exportez une sauvegarde dès que possible depuis « Données & export ».");
    return; // Ne pas tenter de synchroniser un état qui n'a pas pu être sauvegardé localement.
  }
  scheduleSyncPush();
}

/* =========================================================================
   INSTANTANÉS DE SÉCURITÉ — avant toute opération qui remplace ou vide une
   grande partie des données (archivage annuel, réinitialisation complète,
   import d'une sauvegarde), une copie complète de l'état est conservée
   localement pendant 10 jours. Permet de revenir en arrière même après une
   erreur de manipulation, indépendamment de la synchronisation.
   ========================================================================= */
const SNAPSHOTS_KEY = "sdcqn_v1_snapshots";
const SNAPSHOT_RETENTION_DAYS = 10;

function takeSafetySnapshot(label){
  try{
    let snapshots = [];
    try{ snapshots = JSON.parse(localStorage.getItem(SNAPSHOTS_KEY) || "[]"); }catch(e){}
    snapshots.push({ id: uid("snap"), timestamp: Date.now(), label, state: deepClone(state) });
    const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS*86400000;
    snapshots = snapshots.filter(s=> s.timestamp >= cutoff);
    localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snapshots));
  }catch(e){
    // Une sauvegarde de sécurité qui échoue (espace insuffisant) ne doit jamais bloquer
    // l'action demandée par l'utilisateur — elle est simplement ignorée silencieusement.
    console.error("Échec de la sauvegarde de sécurité automatique", e);
  }
}

function getSafetySnapshots(){
  try{
    const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS*86400000;
    const snapshots = JSON.parse(localStorage.getItem(SNAPSHOTS_KEY) || "[]");
    return snapshots.filter(s=> s.timestamp >= cutoff).sort((a,b)=> b.timestamp - a.timestamp);
  }catch(e){ return []; }
}

let state = loadState();
if(!state.secteurs || !state.secteurs.length) state.secteurs = DEFAULT_SECTEURS.slice();
if(!state.responsables) state.responsables = [];
if(!state.reunionsCodinorm) state.reunionsCodinorm = [];
if(!state.rappels) state.rappels = [];
if(!state.entreprises) state.entreprises = [];
if(!state.archives) state.archives = [];
// Migration des anciens échantillons vers le nouveau format (produits structurés)
(state.echantillons||[]).forEach(e=>{
  if(e.parametres && !e.parametresPhysico && !e.parametresMicro){
    e.parametresPhysico = e.parametres;
    e.parametresMicro = [];
    delete e.parametres;
  }
  if(!e.produits && e.produit){
    e.produits = [{ id: uid("prod"), nom: e.produit, dateProduction:"", dateExpiration:"", numeroLot:"" }];
  }
  if(!e.produits) e.produits = [];
  // Migration : la conclusion de conformité devient individuelle par produit prélevé,
  // puis se décompose en conclusion physicochimique et conclusion microbiologique.
  e.produits.forEach(p=>{
    if(!p.statut) p.statut = e.statut || "En attente";
    if(!p.statutPhysico) p.statutPhysico = p.statut;
    if(!p.statutMicro) p.statutMicro = p.statut;
  });
});
if(!state.commissions) state.commissions = {};
// Riz et Tabac ne sont plus recréées automatiquement si elles ont été supprimées : elles sont
// traitées comme n'importe quelle autre commission/comité (structure assurée ci-dessous
// uniquement pour celles qui existent réellement dans les données).
Object.keys(state.commissions).forEach(k=>{
  const c = state.commissions[k];
  c.sessions = c.sessions || []; c.membres = c.membres || []; c.actions = c.actions || []; c.agrements = c.agrements || [];
  if(!c.nom) c.nom = (k==="riz" ? "Commission Retraitement Riz" : k==="tabac" ? "Commission Tabac" : "Commission / Comité");
});
// Restructuration : les structures demandeuses appartiennent désormais à une session précise
// (une session peut avoir ses propres structures, puis chaque structure ses propres missions),
// plutôt qu'à la commission dans son ensemble. Les anciennes structures non rattachées sont
// migrées automatiquement vers la première session existante (ou une session créée pour
// l'occasion si la commission n'en avait aucune), afin de ne perdre aucune donnée.
function migrateFlatStructuresToSessions_(collection){
  Object.keys(collection).forEach(key=>{
    const c = collection[key];
    c.sessions.forEach(s=>{ if(!s.structures) s.structures = []; });
    if(c.agrements && c.agrements.length){
      let target = c.sessions[0];
      if(!target){
        target = { id: uid("sess"), date: todayISO(), lieu:"", titre:"Structures importées (avant réorganisation)", participants:"", ordreDuJour:"", decisions:"", structures:[] };
        c.sessions.push(target);
      }
      if(!target.structures) target.structures = [];
      target.structures.push(...c.agrements);
      c.agrements = [];
    }
  });
}
migrateFlatStructuresToSessions_(state.commissions);
if(!state.dossiers) state.dossiers = {};
Object.keys(state.dossiers).forEach(k=>{
  const dd = state.dossiers[k];
  dd.sessions = dd.sessions || []; dd.membres = dd.membres || []; dd.actions = dd.actions || []; dd.agrements = dd.agrements || [];
  if(!dd.nom) dd.nom = "Dossier suivi";
});
migrateFlatStructuresToSessions_(state.dossiers);

/* ---------------------------- Utilitaires ---------------------------- */

function fmtDate(iso){
  if(!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if(isNaN(d)) return iso;
  return d.toLocaleDateString("fr-FR", { day:"2-digit", month:"2-digit", year:"numeric" });
}
function fmtDateShort(iso){
  if(!iso) return { d:"--", m:"" };
  const d = new Date(iso + "T00:00:00");
  return { d: String(d.getDate()).padStart(2,"0"), m: MOIS_FR[d.getMonth()] };
}
function todayISO(){ return new Date().toISOString().slice(0,10); }

/* =========================================================================
   AGENDA AUTOMATIQUE — tout enregistrement dont la date n'est pas encore
   arrivée obtient automatiquement un rappel dans l'agenda (visible dans la
   bannière du tableau de bord). Dès que la date est dépassée, ce rappel
   automatique disparaît de l'agenda : l'activité reste normalement visible
   dans son propre module (missions, activités, CODINORM, commissions), qui
   demeure la seule source d'origine de l'information.
   ========================================================================= */

// Crée, met à jour ou retire le rappel automatique lié à un enregistrement source.
// sourceType/sourceId identifient l'enregistrement d'origine (ex: "mission", m.id).
function syncAutoRappel(sourceType, sourceId, { date, titre, lieu, type }){
  const existingIdx = state.rappels.findIndex(r => r.auto && r.sourceType===sourceType && r.sourceId===sourceId);
  const dateOk = date && date >= todayISO();

  if(!dateOk){
    if(existingIdx >= 0) state.rappels.splice(existingIdx, 1);
    return;
  }
  const payload = {
    type: type || "Autre", statut:"À venir", titre: titre || "(sans titre)",
    date, heure:"", lieu: lieu||"", rappelJours:2, notes:"",
    auto:true, sourceType, sourceId,
  };
  if(existingIdx >= 0){
    state.rappels[existingIdx] = { ...state.rappels[existingIdx], ...payload };
  } else {
    state.rappels.push({ id: uid("rap"), dernierRappelNotifie:null, pieceJointes:[], ...payload });
  }
}

// Retire un rappel automatique quand son enregistrement source est supprimé.
function removeAutoRappel(sourceType, sourceId){
  const idx = state.rappels.findIndex(r => r.auto && r.sourceType===sourceType && r.sourceId===sourceId);
  if(idx >= 0) state.rappels.splice(idx, 1);
}

// À chaque démarrage : retire les rappels automatiques dont la date est désormais passée
// (l'activité reste consultable normalement dans son propre module).
function pruneExpiredAutoRappels(){
  const today = todayISO();
  const before = state.rappels.length;
  state.rappels = state.rappels.filter(r => !(r.auto && r.date && r.date < today));
  if(state.rappels.length !== before) saveState();
}
pruneExpiredAutoRappels();

function nextRef(kind){
  const year = new Date().getFullYear();
  const list = kind === "mission" ? state.missions : state.echantillons;
  const prefix = kind === "mission" ? "M" : "ECH";
  const count = list.filter(x => (x.ref||"").includes(`-${year}-`)).length + 1;
  return `${prefix}-${year}-${String(count).padStart(4,"0")}`;
}

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> t.classList.remove("show"), 2600);
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------------------------- Navigation ---------------------------- */

const VIEW_META = {
  dashboard:   { title:"Tableau de bord", sub:"Vue d'ensemble de l'activité de la Sous-direction" },
  commissions: { title:"Commissions & Comités", sub:"Toutes les commissions et comités suivis par le service" },
  "commission-detail": { title:"Commission / Comité", sub:"Sessions et structures demandeuses" },
  dossiers:        { title:"Dossiers suivis", sub:"Autres dossiers suivis par le service, structurés comme les commissions" },
  "dossier-detail": { title:"Dossier suivi", sub:"Sessions et éléments suivis" },
  archives:    { title:"Archives", sub:"Données conservées par année, consultables à tout moment" },
  missions:    { title:"Missions de contrôle", sub:"Missions de terrain et échantillons prélevés" },
  activites:   { title:"Réunions & activités", sub:"Réunions, ateliers, séminaires et autres activités" },
  codinorm:    { title:"Réunion CODINORM", sub:"Suivi des réunions avec CODINORM" },
  rappels:     { title:"Agenda & Rappels", sub:"Activités à venir, rappels et alertes" },
  entreprises: { title:"Base de données", sub:"Répertoire des entreprises et structures suivies" },
  rapport:     { title:"Rapport d'activité", sub:"Génération d'un rapport de synthèse en Word ou PDF" },
  parametres:  { title:"Données & export", sub:"Sauvegarde, import et paramètres de la plateforme" },
};

// Libellés dynamiques : chaque commission/comité porte son propre nom (state.commissions[key].nom),
// permettant d'en ajouter autant que nécessaire sans code supplémentaire.
function commissionMeta(key){
  const nom = (state.commissions[key] && state.commissions[key].nom) || "Commission / Comité";
  return { name: nom, agrementTab: "Structures demandeuses", agrementFull: "cette commission", agrementBtn: "Ajouter une structure demandeuse" };
}

let currentCommissionKey = null;
let currentDossierKey = null;
let currentViewName = null;
let viewHistory = [];

function openCommissionDetail(key){
  currentCommissionKey = key;
  goView("commission-detail");
}
function openDossierDetail(key){
  currentDossierKey = key;
  goView("dossier-detail");
}

function goView(name){
  if(currentViewName && currentViewName !== name) viewHistory.push(currentViewName);
  currentViewName = name;
  document.querySelectorAll(".view").forEach(v => v.hidden = true);
  document.getElementById("view-"+name).hidden = false;
  const activeNavName = (name === "commission-detail") ? "commissions" : (name === "dossier-detail") ? "dossiers" : name;
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === activeNavName));
  const activeItem = document.querySelector(`.nav-item[data-view="${activeNavName}"]`);
  const parentSection = activeItem?.closest(".nav-section-items");
  if(parentSection && parentSection.classList.contains("collapsed")){
    const key = parentSection.id.replace("navSection-","");
    navCollapsed[key] = false;
    localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(navCollapsed));
    applyNavCollapseState();
  }
  if(name === "commission-detail" && currentCommissionKey && state.commissions[currentCommissionKey]){
    document.getElementById("viewTitle").textContent = commissionMeta(currentCommissionKey).name;
    document.getElementById("viewSubtitle").textContent = "Sessions et structures demandeuses de cette commission / ce comité";
  } else if(name === "dossier-detail" && currentDossierKey && state.dossiers[currentDossierKey]){
    document.getElementById("viewTitle").textContent = dossierMeta(currentDossierKey).name;
    document.getElementById("viewSubtitle").textContent = "Sessions et éléments suivis de ce dossier";
  } else {
    document.getElementById("viewTitle").textContent = VIEW_META[name].title;
    document.getElementById("viewSubtitle").textContent = VIEW_META[name].sub;
  }
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarBackdrop")?.classList.remove("show");
  if(name === "dashboard") renderDashboard();
  if(name === "commissions") renderCommissionsList();
  if(name === "commission-detail") renderCommission(currentCommissionKey);
  if(name === "dossiers") renderDossiersList();
  if(name === "dossier-detail") renderDossier(currentDossierKey);
  if(name === "missions"){ renderMissions(); renderEchantillons(); }
  if(name === "activites") renderActivites();
  if(name === "codinorm") renderCodinorm();
  if(name === "rappels") renderRappels();
  if(name === "entreprises") renderEntreprises();
  if(name === "rapport") renderRapportApercu();
  if(name === "parametres") renderParametres();
  if(name === "archives") renderArchives();
}

document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => goView(item.dataset.view));
});
document.querySelectorAll("[data-view-link]").forEach(el => {
  el.addEventListener("click", (e) => { e.preventDefault(); goView(el.dataset.viewLink); });
});

// Sections de navigation repliables (utile notamment sur mobile, pour raccourcir le menu).
// L'état plié/déplié de chaque section est mémorisé d'une session à l'autre.
const NAV_COLLAPSE_KEY = "sdcqn_nav_collapsed";
let navCollapsed = {};
try{ navCollapsed = JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY) || "{}"); }catch(e){}
function applyNavCollapseState(){
  document.querySelectorAll(".nav-section-label[data-toggle-section]").forEach(btn=>{
    const key = btn.dataset.toggleSection;
    const items = document.getElementById("navSection-"+key);
    const isCollapsed = !!navCollapsed[key];
    if(items) items.classList.toggle("collapsed", isCollapsed);
    btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  });
}
document.querySelectorAll(".nav-section-label[data-toggle-section]").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const key = btn.dataset.toggleSection;
    navCollapsed[key] = !navCollapsed[key];
    localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(navCollapsed));
    applyNavCollapseState();
  });
});
applyNavCollapseState();

document.getElementById("menuToggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("sidebarBackdrop")?.classList.toggle("show");
});
document.getElementById("sidebarBackdrop")?.addEventListener("click", () => {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarBackdrop").classList.remove("show");
});

/* =========================================================================
   RECHERCHE GLOBALE — cherche simultanément dans les missions, échantillons,
   entreprises, activités/réunions et CODINORM. Accessible via la petite
   icône loupe en haut de l'application, ou le raccourci Ctrl/Cmd+K.
   ========================================================================= */
const GS_ICONS = {
  mission: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  ech: '<path d="M9 2v6L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-11V2M9 2h6M8 15h8"/>',
  ent: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>',
  act: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/>',
  cod: '<circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/>',
  dossier: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  commission: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
};
function gsIcon(kind){ return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">${GS_ICONS[kind]}</svg>`; }

function runGlobalSearch(q){
  q = q.trim().toLowerCase();
  if(!q) return [];
  const results = [];

  groupMissionsList(state.missions).slice().reverse().forEach(g=>{
    const hay = `${g.objet||""} ${g.entreprise||""} ${g.lieu||""} ${g.secteur||""}`.toLowerCase();
    if(hay.includes(q)) results.push({ kind:"mission", id:g.members[0].id, title:g.objet||"(sans objet)", meta:`${g.entreprise||"—"} · ${fmtDate(g.dateDebut)}` });
  });
  state.echantillons.slice().reverse().forEach(e=>{
    const produits = (e.produits||[]).map(p=>p.nom).join(" ");
    const hay = `${e.ref||""} ${e.entreprise||""} ${produits}`.toLowerCase();
    if(hay.includes(q)) results.push({ kind:"ech", id:e.id, title:e.ref||produits||"Échantillon", meta:`${e.entreprise||"—"} · ${produits||"—"}` });
  });
  state.entreprises.slice().reverse().forEach(ent=>{
    const hay = `${ent.nom||""} ${ent.representant||""} ${ent.localisation||""}`.toLowerCase();
    if(hay.includes(q)) results.push({ kind:"ent", id:ent.id, title:ent.nom||"Entreprise", meta:ent.localisation||ent.secteur||"—" });
  });
  state.activites.slice().reverse().forEach(a=>{
    const hay = `${a.titre||""} ${a.lieu||""} ${a.type||""}`.toLowerCase();
    if(hay.includes(q)) results.push({ kind:"act", id:a.id, title:a.titre||"Activité", meta:`${a.type||"—"} · ${fmtDate(a.date)}` });
  });
  state.reunionsCodinorm.slice().reverse().forEach(c=>{
    const hay = `${c.titre||""} ${c.normeAnalysee||""}`.toLowerCase();
    if(hay.includes(q)) results.push({ kind:"cod", id:c.id, title:c.titre||c.normeAnalysee||"Réunion CODINORM", meta:fmtDate(c.date) });
  });
  Object.keys(state.dossiers).forEach(key=>{
    const dd = state.dossiers[key];
    const nbStruct = dd.sessions.reduce((s,x)=> s+(x.structures||[]).length, 0);
    if((dd.nom||"").toLowerCase().includes(q)) results.push({ kind:"dossier", id:key, title:dd.nom, meta:`${dd.sessions.length} session(s) · ${nbStruct} élément(s)` });
  });
  Object.keys(state.commissions).forEach(key=>{
    const cc = state.commissions[key];
    const nbStruct = cc.sessions.reduce((s,x)=> s+(x.structures||[]).length, 0);
    if((cc.nom||"").toLowerCase().includes(q)) results.push({ kind:"commission", id:key, title:cc.nom, meta:`${cc.sessions.length} session(s) · ${nbStruct} structure(s)` });
  });

  return results;
}

const GS_LABELS = { mission:"Missions", ech:"Échantillons", ent:"Entreprises", act:"Réunions & activités", cod:"CODINORM", dossier:"Dossiers suivis", commission:"Commissions & Comités" };
const GS_VIEWS = { mission:"missions", ech:"missions", ent:"entreprises", act:"activites", cod:"codinorm" };
const GS_OPENERS = { mission: openMissionFiche, ech: openEchFiche, ent: openEntrepriseFiche, act: openActFiche, cod: openCodinormFiche };

function renderGlobalSearchResults(q){
  const box = document.getElementById("globalSearchResults");
  if(!q.trim()){
    box.innerHTML = `<div class="gs-empty">Tapez pour rechercher dans toute l'application.</div>`;
    return;
  }
  const results = runGlobalSearch(q).slice(0, 40);
  if(!results.length){
    box.innerHTML = `<div class="gs-empty">Aucun résultat pour « ${escapeHtml(q)} ».</div>`;
    return;
  }
  const grouped = {};
  results.forEach(r=>{ (grouped[r.kind] = grouped[r.kind]||[]).push(r); });
  box.innerHTML = Object.keys(grouped).map(kind=>`
    <div class="gs-group-label">${GS_LABELS[kind]}</div>
    ${grouped[kind].slice(0,8).map(r=>`
      <div class="gs-result" data-gs-kind="${r.kind}" data-gs-id="${r.id}">
        <div class="gs-result-icon">${gsIcon(r.kind)}</div>
        <div>
          <div class="gs-result-title">${escapeHtml(r.title)}</div>
          <div class="gs-result-meta">${escapeHtml(r.meta)}</div>
        </div>
      </div>`).join("")}
  `).join("");
  box.querySelectorAll("[data-gs-kind]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const kind = el.dataset.gsKind, id = el.dataset.gsId;
      closeGlobalSearch();
      if(kind==="dossier"){ openDossierDetail(id); return; }
      if(kind==="commission"){ openCommissionDetail(id); return; }
      goView(GS_VIEWS[kind]);
      GS_OPENERS[kind](id);
    });
  });
}

function openGlobalSearch(){
  document.getElementById("searchOverlay").hidden = false;
  const input = document.getElementById("globalSearchInput");
  input.value = "";
  renderGlobalSearchResults("");
  setTimeout(()=> input.focus(), 30);
}
function closeGlobalSearch(){
  document.getElementById("searchOverlay").hidden = true;
}
document.getElementById("btnGlobalSearch")?.addEventListener("click", openGlobalSearch);
document.getElementById("btnCloseGlobalSearch")?.addEventListener("click", closeGlobalSearch);
document.getElementById("searchOverlay")?.addEventListener("click", (e)=>{ if(e.target.id==="searchOverlay") closeGlobalSearch(); });
document.getElementById("globalSearchInput")?.addEventListener("input", (e)=> renderGlobalSearchResults(e.target.value));
document.addEventListener("keydown", (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="k"){ e.preventDefault(); openGlobalSearch(); }
  else if(e.key==="Escape" && !document.getElementById("searchOverlay").hidden){ closeGlobalSearch(); }
});

/* =========================================================================
   BOUTON RETOUR ANDROID (physique ou geste) — uniquement actif dans
   l'application Android (Capacitor) ; sans effet sur les versions
   Windows/Linux/Web où l'objet Capacitor n'existe pas.
   Ordre de priorité : fermer un tiroir ouvert > fermer un modal de
   confirmation > fermer le menu mobile > fermer le menu des alertes >
   revenir à l'écran précédemment consulté > quitter l'application.
   ========================================================================= */
if(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App){
  window.Capacitor.Plugins.App.addListener("backButton", ()=>{
    if(!modalOverlay.hidden){
      document.getElementById("modalCancel")?.click();
      return;
    }
    if(!overlay.hidden){
      closeDrawer();
      return;
    }
    if(document.getElementById("sidebar").classList.contains("open")){
      document.getElementById("sidebar").classList.remove("open");
      document.getElementById("sidebarBackdrop")?.classList.remove("show");
      return;
    }
    if(!document.getElementById("bellDropdown").hidden){
      document.getElementById("bellDropdown").hidden = true;
      return;
    }
    if(viewHistory.length){
      const previous = viewHistory.pop();
      currentViewName = null; // évite de ré-empiler cette même transition
      goView(previous);
      return;
    }
    if(currentViewName !== "dashboard"){
      goView("dashboard");
      return;
    }
    window.Capacitor.Plugins.App.exitApp();
  });
}

/* =========================================================================
   DRAWER générique
   ========================================================================= */

const overlay = document.getElementById("overlay");
const drawer = document.getElementById("drawer");

function openDrawer(html, onMount){
  drawer.innerHTML = html;
  overlay.hidden = false;
  requestAnimationFrame(()=> { attachSpellCorrectButtons(drawer); onMount && onMount(); });
  document.getElementById("drawerClose")?.addEventListener("click", closeDrawer);
}
function closeDrawer(){ overlay.hidden = true; drawer.innerHTML = ""; }

// Ajoute automatiquement un bouton "✨" de correction orthographe/grammaire (IA) sur chaque
// zone de texte d'un formulaire — aucune modification nécessaire dans chaque formulaire.
function attachSpellCorrectButtons(container){
  container.querySelectorAll("textarea").forEach(ta=>{
    if(ta.dataset.correctorAttached) return;
    ta.dataset.correctorAttached = "1";
    const wrap = document.createElement("div");
    wrap.className = "textarea-corrector-wrap";
    ta.parentNode.insertBefore(wrap, ta);
    wrap.appendChild(ta);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "textarea-corrector-btn";
    btn.title = "Corriger l'orthographe et la grammaire avec l'IA";
    btn.textContent = "✨";
    wrap.appendChild(btn);
    btn.addEventListener("click", async ()=>{
      if(!aiReady()){ toast("Renseignez et activez une clé IA dans « Données & export » → Intelligence artificielle."); return; }
      const text = ta.value.trim();
      if(!text){ toast("Ce champ est vide."); return; }
      const original = btn.textContent;
      btn.disabled = true; btn.textContent = "…";
      try{
        const prompt = `Corrige uniquement l'orthographe et la grammaire du texte français suivant, sans changer le sens, le ton, le niveau de langue, ni la mise en forme (conserve exactement les retours à la ligne et la ponctuation d'origine sauf erreur). Réponds UNIQUEMENT par le texte corrigé, sans aucun commentaire, introduction ni guillemets.\n\n${text}`;
        const corrected = await callClaudeAPI(prompt);
        if(corrected && corrected.trim()){ ta.value = corrected.trim(); toast("Texte corrigé — relisez avant d'enregistrer."); }
        else toast("Aucune correction proposée.");
      }catch(err){
        toast("Échec de la correction : " + err.message);
      }
      btn.disabled = false; btn.textContent = original;
    });
  });
}
overlay.addEventListener("click", (e)=>{ if(e.target === overlay) closeDrawer(); });
document.addEventListener("keydown", (e)=>{ if(e.key === "Escape" && !overlay.hidden) closeDrawer(); });

/* =========================================================================
   Confirmation / saisie internes — remplacent window.confirm()/window.prompt(),
   qui se sont montrées peu fiables dans l'environnement Electron de cette
   application (boîte de dialogue qui ne s'affiche pas, ou qui bloque
   l'application jusqu'à un redémarrage). Ces fonctions utilisent un petit
   modal HTML interne et renvoient une Promise, comme leurs équivalents natifs.
   ========================================================================= */
const modalOverlay = document.getElementById("modalOverlay");
function appConfirm(message, okLabel){
  return new Promise(resolve=>{
    document.getElementById("modalMessage").textContent = message;
    document.getElementById("modalInputWrap").hidden = true;
    const okBtn = document.getElementById("modalOk");
    const cancelBtn = document.getElementById("modalCancel");
    okBtn.textContent = okLabel || "Confirmer";
    cancelBtn.hidden = false;
    modalOverlay.hidden = false;
    function cleanup(result){
      modalOverlay.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("click", onOverlay);
      resolve(result);
    }
    function onOk(){ cleanup(true); }
    function onCancel(){ cleanup(false); }
    function onOverlay(e){ if(e.target === modalOverlay) cleanup(false); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modalOverlay.addEventListener("click", onOverlay);
    setTimeout(()=> okBtn.focus(), 30);
  });
}
function appPrompt(message, defaultValue){
  return new Promise(resolve=>{
    document.getElementById("modalMessage").textContent = message;
    const inputWrap = document.getElementById("modalInputWrap");
    const input = document.getElementById("modalInput");
    inputWrap.hidden = false;
    input.value = defaultValue || "";
    const okBtn = document.getElementById("modalOk");
    const cancelBtn = document.getElementById("modalCancel");
    okBtn.textContent = "Valider";
    cancelBtn.hidden = false;
    modalOverlay.hidden = false;
    function cleanup(result){
      modalOverlay.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("click", onOverlay);
      input.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onOk(){ cleanup(input.value); }
    function onCancel(){ cleanup(null); }
    function onOverlay(e){ if(e.target === modalOverlay) cleanup(null); }
    function onKeydown(e){ if(e.key==="Enter"){ e.preventDefault(); onOk(); } }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modalOverlay.addEventListener("click", onOverlay);
    input.addEventListener("keydown", onKeydown);
    setTimeout(()=>{ input.focus(); input.select(); }, 30);
  });
}

// Analyse IA générique de la fiche actuellement ouverte : fonctionne sur TOUS les types de
// fiches (mission, échantillon, activité, CODINORM, commission, rappel, entreprise…) sans
// code spécifique à chacune — on lit simplement le texte affiché dans la fiche.
document.addEventListener("click", async (e)=>{
  const btn = e.target.closest("#btnFicheAnalyzeIa");
  if(!btn) return;
  if(!aiReady()){ toast("Renseignez et activez une clé IA dans « Données & export » → Intelligence artificielle."); return; }
  const body = drawer.querySelector(".drawer-body");
  const titleEl = drawer.querySelector(".drawer-head h3");
  if(!body) return;
  let resultBox = body.querySelector("#ficheAiResult");
  if(!resultBox){
    resultBox = document.createElement("div");
    resultBox.id = "ficheAiResult";
    resultBox.style.marginTop = "16px";
    body.appendChild(resultBox);
  }
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Analyse en cours…";
  resultBox.innerHTML = "";
  try{
    const texte = (body.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const prompt = `Tu aides un service ivoirien de contrôle qualité (Sous-Direction du Contrôle de la Qualité et des Normes, MCIA) à interpréter une fiche de son application de suivi (titre : "${titleEl?titleEl.textContent:"Fiche"}").

Voici les informations affichées dans cette fiche :
${texte.slice(0, 12000)}

Analyse ces informations et rédige, en français :
1. Un résumé en 1-2 phrases de ce dont il s'agit.
2. Les points qui méritent attention ou vigilance, s'il y en a (délais, non-conformités, incohérences, échéances proches…).
3. Si tout paraît normal, dis-le simplement sans forcer une remarque.

N'invente aucune information absente du texte ci-dessus. Écris en paragraphes courts, sans liste à puces et sans titre.`;
    const text = await callClaudeAPI(prompt);
    resultBox.innerHTML = `<div class="form-section-title">Analyse IA</div><div class="ai-result-box">${escapeHtml(text)}</div><div class="ai-result-meta">Analyse générée par intelligence artificielle — à vérifier avant toute utilisation officielle.</div>`;
  }catch(err){
    resultBox.innerHTML = `<p class="text-muted" style="font-size:12.5px;">Erreur : ${escapeHtml(err.message)}</p>`;
    toast("Échec de l'analyse IA.");
  }
  btn.disabled = false; btn.textContent = original;
});

function drawerShell(title, bodyHtml, footHtml){
  return `
    <div class="drawer-head">
      <h3>${title}</h3>
      <button class="icon-btn" id="drawerClose" aria-label="Fermer">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="drawer-body">${bodyHtml}</div>
    <div class="drawer-foot">${footHtml}</div>
  `;
}

// Champ en lecture seule pour les fiches de consultation (valeur : HTML déjà préparé/échappé par l'appelant)
function roField(label, valueHtml){
  return `<div><label>${escapeHtml(label)}</label><div>${valueHtml || "—"}</div></div>`;
}
// Pied de fiche standard : Fermer + Modifier
function ficheFoot(){
  return `<button class="btn" id="btnFicheAnalyzeIa" title="Demander à l'IA d'analyser et d'interpréter cette fiche">✨ Analyser avec l'IA</button><div style="flex:1"></div><button class="btn" id="drawerCancel">Fermer</button><button class="btn btn-primary" id="btnFicheEdit">Modifier</button>`;
}

/* =========================================================================
   PIÈCES JOINTES — composant générique réutilisé dans tous les formulaires
   Les fichiers sont envoyés et conservés sur le serveur de synchronisation
   (dossier "pieces-jointes" à côté du serveur). Nécessite que la
   synchronisation soit activée et que l'élément soit déjà enregistré.
   ========================================================================= */

function formatFileSize(bytes){
  bytes = bytes || 0;
  if(bytes < 1024) return bytes + " o";
  if(bytes < 1024*1024) return (bytes/1024).toFixed(1) + " Ko";
  return (bytes/1024/1024).toFixed(2) + " Mo";
}

// Fichiers joints en attente pour un NOUVEL enregistrement pas encore créé : ils sont
// envoyés au serveur immédiatement (comme pour un élément existant), puis rattachés à
// l'enregistrement dès sa création — plus besoin d'enregistrer d'abord pour joindre un
// fichier, sur n'importe quel formulaire de l'application.
let pendingAttachments = [];

// À appeler juste après la création d'un nouvel enregistrement, pour lui rattacher les
// fichiers déjà envoyés au serveur pendant la saisie du formulaire.
function consumePendingAttachments(){
  const list = pendingAttachments;
  pendingAttachments = [];
  return list;
}

function attachmentsSectionHtml(record){
  return `
    <div class="form-section-title">Pièces jointes</div>
    <div id="attachStatus" class="text-muted" style="font-size:12px; margin-bottom:8px;"></div>
    <div id="attachList" style="margin-bottom:10px;"></div>
    <label class="btn btn-sm" style="cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      Joindre un fichier
      <input type="file" id="attachFileInput" style="display:none;">
    </label>
    ${!record ? `<p class="text-muted" style="font-size:11px; margin-top:6px;">Les fichiers joints ici seront automatiquement rattachés dès l'enregistrement.</p>` : ""}`;
}

// À appeler dans le callback d'ouverture du tiroir, après insertion du HTML ci-dessus.
// record vaut null pour un nouvel élément pas encore créé : les fichiers sont alors
// conservés dans pendingAttachments jusqu'à l'enregistrement (voir consumePendingAttachments).
function setupAttachments(record){
  if(record && !record.pieceJointes) record.pieceJointes = [];
  if(!record) pendingAttachments = []; // nouvelle saisie : on repart d'une liste vide
  const getList = () => record ? record.pieceJointes : pendingAttachments;

  const statusBox = document.getElementById("attachStatus");
  const listBox = document.getElementById("attachList");
  const input = document.getElementById("attachFileInput");
  if(!statusBox || !listBox || !input) return;

  function renderList(){
    const list = getList();
    if(!list.length){
      listBox.innerHTML = `<p class="text-muted" style="font-size:12.5px;">Aucun fichier joint.</p>`;
      return;
    }
    listBox.innerHTML = list.map(f=>`
      <div class="attach-item">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
        <span class="attach-name" title="${escapeHtml(f.originalName)}">${escapeHtml(f.originalName)}</span>
        <span class="attach-size">${formatFileSize(f.size)}</span>
        <button class="icon-btn" data-download-file="${f.id}" title="Télécharger">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
        </button>
        <button class="icon-btn" data-remove-file="${f.id}" title="Retirer">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>`).join("");
    listBox.querySelectorAll("[data-download-file]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const f = getList().find(x=>x.id===btn.dataset.downloadFile);
        if(f) downloadAttachment(f.id, f.originalName);
      });
    });
    listBox.querySelectorAll("[data-remove-file]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        if(!await appConfirm("Retirer ce fichier joint ?")) return;
        const fid = btn.dataset.removeFile;
        if(record){ record.pieceJointes = record.pieceJointes.filter(x=>x.id!==fid); saveState(); }
        else{ pendingAttachments = pendingAttachments.filter(x=>x.id!==fid); }
        renderList();
        if(syncCfg.enabled && syncCfg.url){ try{ await apiDeleteFile(fid); }catch(e){} }
      });
    });
  }
  renderList();

  if(!syncCfg.enabled || !syncCfg.url){
    statusBox.textContent = "Activez la synchronisation (Données & export) pour pouvoir joindre des fichiers.";
    input.disabled = true;
    return;
  }

  input.addEventListener("change", async ()=>{
    const file = input.files[0];
    if(!file) return;
    if(file.size > 18*1024*1024){ toast("Fichier trop volumineux (18 Mo maximum)."); input.value=""; return; }
    statusBox.textContent = "Envoi en cours…";
    try{
      const dataBase64 = await new Promise((resolve,reject)=>{
        const reader = new FileReader();
        reader.onload = ()=> resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const meta = await apiPostFile({ originalName:file.name, mimeType:file.type||"application/octet-stream", dataBase64 });
      if(record){ record.pieceJointes.push(meta); saveState(); }
      else{ pendingAttachments.push(meta); }
      renderList();
      statusBox.textContent = "";
      toast("Fichier joint.");
    }catch(err){
      statusBox.textContent = "";
      toast("Échec de l'envoi (serveur injoignable ou clé invalide).");
    }
    input.value = "";
  });
}

/* =========================================================================
   MISSIONS
   ========================================================================= */

function secteurOptions(selected){
  return state.secteurs.map(s => `<option value="${escapeHtml(s)}" ${s===selected?"selected":""}>${escapeHtml(s)}</option>`).join("");
}

function missionOptions(selectedId){
  return `<option value="">— Aucune / hors mission —</option>` + state.missions
    .slice().sort((a,b)=> (b.dateDebut||"").localeCompare(a.dateDebut||""))
    .map(m => `<option value="${m.id}" ${m.id===selectedId?"selected":""}>${escapeHtml(m.ref)} — ${escapeHtml(m.entreprise)} (${fmtDate(m.dateDebut)})</option>`).join("");
}

function responsableOptions(selected){
  let list = state.responsables.slice();
  if(selected && !list.includes(selected)) list.unshift(selected);
  return list.map(r => `<option value="${escapeHtml(r)}" ${r===selected?"selected":""}>${escapeHtml(r)}</option>`).join("");
}

const STATUT_MISSION_BADGE = {
  "Programmée": "badge-success", "Non-programmée": "badge-warn"
};

function openMissionForm(id, prefillFrom, onSaved){
  const m = id ? state.missions.find(x=>x.id===id) : null;
  const p = m || prefillFrom || null; // source d'affichage/pré-remplissage (original si duplication)
  // Échantillon déjà lié à cette mission (le plus récent si plusieurs existent), pour pré-remplir les produits prélevés
  const linkedEch = p ? state.echantillons.filter(e=>e.missionId===p.id).sort((a,b)=>(b.datePrelevement||"").localeCompare(a.datePrelevement||""))[0] : null;
  const produits = (linkedEch?.produits && linkedEch.produits.length) ? linkedEch.produits : [];

  const html = drawerShell(
    m ? `Modifier la mission ${escapeHtml(m.ref)}` : (prefillFrom ? `Dupliquer la mission ${escapeHtml(prefillFrom.ref)}` : "Nouvelle mission de contrôle"),
    `
    <div class="form-section-title">Mission</div>
    <p class="text-muted" style="font-size:12px; margin-top:-6px;">Période et objet de la mission de contrôle.</p>
    <div class="field-grid">
      <div class="field"><label>Date de début de la mission</label><input type="date" id="f_datedebut" value="${p?.dateDebut || todayISO()}"></div>
      <div class="field"><label>Date de fin de la mission</label><input type="date" id="f_datefin" value="${p?.dateFin || p?.dateDebut || todayISO()}"></div>
      <div class="field">
        <label>Statut</label>
        <select id="f_statut">
          ${["Programmée","Non-programmée"].map(s=>`<option ${(p?.statut||"Programmée")===s?"selected":""}>${s}</option>`).join("")}
        </select>
      </div>
      <div class="field" id="f_statut_autre_wrap" hidden><label>Autre (précisez)</label><input type="text" id="f_statut_autre" value="${escapeHtml(p?.statutAutre||"")}" placeholder="Précisez la situation"></div>
    </div>
    <div class="field-grid">
      <div class="field"><label>Objet de la mission</label><input type="text" id="f_objet" value="${escapeHtml(p?.objet||"")}" placeholder="Ex : Contrôle de conformité des stocks alimentaires"></div>
      <div class="field"><label>Secteur d'activité</label><select id="f_secteur"><option value="">—</option>${secteurOptions(p?.secteur)}</select></div>
    </div>

    <div class="form-section-title">Visite</div>
    <p class="text-muted" style="font-size:12px; margin-top:-6px;">Détails de la visite se déroulant dans cette période, pour cet objet de mission.</p>
    <div class="field-grid">
      <div class="field"><label>Date de visite</label><input type="date" id="f_datevisite" value="${prefillFrom ? todayISO() : (p?.dateVisite || p?.dateDebut || todayISO())}"></div>
      <div class="field"><label>Nom de l'entreprise visitée</label><input type="text" id="f_entreprise" value="${escapeHtml(p?.entreprise||"")}" placeholder="Raison sociale"></div>
      <div class="field"><label>Lieu / commune</label><input type="text" id="f_lieu" value="${escapeHtml(p?.lieu||"")}" placeholder="Ex : Yopougon, Abidjan"></div>
      <div class="field">
        <label>Responsable de mission</label>
        <select id="f_responsable">
          <option value="">—</option>
          ${responsableOptions(p?.responsable)}
        </select>
      </div>
    </div>

    <div class="form-section-title">Prélèvement d'échantillons</div>
    <div id="missionProductList">${produits.map(productRowHtml).join("") || productRowHtml()}</div>
    <button class="btn btn-sm" id="btnAddMissionProduct" type="button" style="margin-bottom:10px;">+ Ajouter un autre produit</button>

    <div class="field"><label>Autres informations</label><textarea id="f_observations" rows="4" placeholder="Constats de terrain, suites données…" spellcheck="true">${escapeHtml(m?.observations||"")}</textarea></div>

    ${attachmentsSectionHtml(m)}
    `,
    `
    ${m ? `<button class="btn btn-danger" id="btnDeleteMission">Supprimer</button><button class="btn" id="btnDuplicateMission">Dupliquer</button>` : ""}
    <div style="flex:1"></div>
    <button class="btn" id="drawerCancel">Annuler</button>
    <button class="btn btn-primary" id="btnSaveMission">${m?"Enregistrer les modifications":"Créer la mission"}</button>
    `
  );
  openDrawer(html, () => {
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(m);

    const statutSelect = document.getElementById("f_statut");
    const autreWrap = document.getElementById("f_statut_autre_wrap");
    function toggleAutre(){ autreWrap.hidden = statutSelect.value !== "Non-programmée"; }
    toggleAutre();
    statutSelect.addEventListener("change", toggleAutre);

    const productList = document.getElementById("missionProductList");
    function bindRemoveProduct(){
      productList.querySelectorAll("[data-remove-product]").forEach(b=>{
        b.onclick = () => { if(productList.children.length>1) b.closest("[data-product-row]").remove(); else b.closest("[data-product-row]").querySelectorAll("input").forEach(i=>i.value=""); };
      });
    }
    bindRemoveProduct();
    document.getElementById("btnAddMissionProduct").addEventListener("click", ()=>{
      productList.insertAdjacentHTML("beforeend", productRowHtml());
      bindRemoveProduct();
    });

    // Pré-remplissage automatique : si la date de visite saisie correspond à la période
    // d'une mission déjà enregistrée (même intervalle début/fin), on reprend sa période et son objet.
    if(!m){
      const dateVisiteInput = document.getElementById("f_datevisite");
      const dateDebutInput = document.getElementById("f_datedebut");
      const dateFinInput = document.getElementById("f_datefin");
      const objetInput = document.getElementById("f_objet");
      let autoFillNote = null;
      dateVisiteInput.addEventListener("change", ()=>{
        const v = dateVisiteInput.value;
        if(!v) return;
        const match = state.missions.find(mm => v >= mm.dateDebut && v <= mm.dateFin);
        if(match){
          dateDebutInput.value = match.dateDebut;
          dateFinInput.value = match.dateFin;
          statutSelect.value = match.statut;
          toggleAutre();
          if(match.statut === "Non-programmée") document.getElementById("f_statut_autre").value = match.statutAutre || "";
          objetInput.value = match.objet || "";
          document.getElementById("f_secteur").value = match.secteur || "";
          if(!autoFillNote){
            autoFillNote = document.createElement("p");
            autoFillNote.className = "text-muted";
            autoFillNote.style.fontSize = "12px";
            autoFillNote.style.margin = "6px 0 0";
            dateVisiteInput.closest(".field-grid").insertAdjacentElement("afterend", autoFillNote);
          }
          autoFillNote.textContent = `Période et objet repris automatiquement de la mission ${match.ref} (${fmtDate(match.dateDebut)} → ${fmtDate(match.dateFin)}), car la date de visite se situe dans cet intervalle.`;
        } else if(autoFillNote){
          autoFillNote.remove();
          autoFillNote = null;
        }
      });
    }

    function readForm(){
      const entreprise = document.getElementById("f_entreprise").value.trim();
      if(!entreprise){ toast("Veuillez indiquer le nom de l'entreprise visitée."); return null; }
      return {
        dateDebut: document.getElementById("f_datedebut").value || todayISO(),
        dateFin: document.getElementById("f_datefin").value || document.getElementById("f_datedebut").value || todayISO(),
        statut: statutSelect.value,
        statutAutre: statutSelect.value === "Non-programmée" ? document.getElementById("f_statut_autre").value.trim() : "",
        objet: document.getElementById("f_objet").value.trim(),
        secteur: document.getElementById("f_secteur").value,
        dateVisite: document.getElementById("f_datevisite").value || todayISO(),
        entreprise,
        lieu: document.getElementById("f_lieu").value.trim(),
        responsable: document.getElementById("f_responsable").value,
        observations: document.getElementById("f_observations").value.trim(),
      };
    }

    document.getElementById("btnSaveMission").addEventListener("click", () => {
      const data = readForm();
      if(!data) return;

      if(data.statut === "Programmée" && (data.dateVisite < data.dateDebut || data.dateVisite > data.dateFin)){
        toast("Pour une mission Programmée, la date de visite doit être comprise entre la date de début et la date de fin de la mission.");
        return;
      }

      let record = m;
      if(m){
        Object.assign(m, data);
        toast("Mission mise à jour.");
      } else {
        record = { id: uid("mis"), ref: nextRef("mission"), ...data, pieceJointes: consumePendingAttachments() };
        state.missions.push(record);
        toast("Mission enregistrée.");
      }

      // Enregistrement automatique des échantillons prélevés lors de la visite
      const produitsData = [...productList.querySelectorAll("[data-product-row]")].map(row => ({
        id: uid("prod"),
        nom: row.querySelector("[data-pr-nom]").value.trim(),
        dateProduction: row.querySelector("[data-pr-dateprod]").value,
        dateExpiration: row.querySelector("[data-pr-dateexp]").value,
        numeroLot: row.querySelector("[data-pr-lot]").value.trim(),
        statutPhysico: row.querySelector("[data-pr-statut-physico]")?.value || "En attente",
        statutMicro: row.querySelector("[data-pr-statut-micro]")?.value || "En attente",
      })).filter(p => p.nom || p.dateProduction || p.dateExpiration || p.numeroLot);

      if(produitsData.length){
        let ech = state.echantillons.filter(e=>e.missionId===record.id).sort((a,b)=>(b.datePrelevement||"").localeCompare(a.datePrelevement||""))[0];
        if(ech){
          ech.produits = produitsData;
          ech.entreprise = data.entreprise;
          ech.datePrelevement = data.dateVisite;
          ech.statut = computeEchStatut(produitsData);
        } else {
          state.echantillons.push({
            id: uid("ech"), ref: nextRef("echantillon"),
            datePrelevement: data.dateVisite, missionId: record.id,
            produits: produitsData, entreprise: data.entreprise,
            dateResultat: "", observationsLabo: "", statut: computeEchStatut(produitsData),
          });
        }
      }

      syncAutoRappel("mission", record.id, { date: record.dateVisite, titre: `Visite — ${record.entreprise||"entreprise à déterminer"}`, lieu: record.lieu, type:"Mission" });
      saveState(); closeDrawer(); renderMissions(); renderEchantillons(); populateSecteurFilter(); renderDashboard();
      onSaved?.(record);
    });

    document.getElementById("btnDeleteMission")?.addEventListener("click", async () => {
      if(!await appConfirm("Supprimer définitivement cette mission ? Les échantillons liés resteront mais perdront leur rattachement.")) return;
      removeAutoRappel("mission", m.id);
      state.missions = state.missions.filter(x=>x.id!==m.id);
      state.echantillons.forEach(e => { if(e.missionId === m.id) e.missionId = ""; });
      saveState(); closeDrawer(); renderMissions();
      toast("Mission supprimée.");
    });
    document.getElementById("btnDuplicateMission")?.addEventListener("click", () => {
      closeDrawer();
      openMissionForm(null, m);
      toast("Formulaire pré-rempli à partir de cette mission — modifiez puis enregistrez.");
    });
  });
}

function openMissionFiche(id){
  const m = state.missions.find(x=>x.id===id);
  if(!m) return;
  const linkedEch = state.echantillons.filter(e=>e.missionId===m.id).sort((a,b)=>(b.datePrelevement||"").localeCompare(a.datePrelevement||""))[0];
  const produits = linkedEch?.produits || [];
  const statutLabel = m.statut === "Non-programmée" && m.statutAutre ? `${m.statut} — ${m.statutAutre}` : m.statut;

  const html = drawerShell(
    `Fiche mission — ${escapeHtml(m.entreprise)}`,
    `
    <div class="form-section-title">Mission</div>
    <div class="field-grid">
      ${roField("Référence", `<span class="mono">${escapeHtml(m.ref)}</span>`)}
      ${roField("Période", `${fmtDate(m.dateDebut)} → ${fmtDate(m.dateFin)}`)}
      ${roField("Statut", `<span class="badge ${STATUT_MISSION_BADGE[m.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(statutLabel||"—")}</span>`)}
      ${roField("Objet de la mission", escapeHtml(m.objet||"—"))}
      ${roField("Secteur d'activité", escapeHtml(m.secteur||"—"))}
    </div>
    <div class="form-section-title">Visite</div>
    <div class="field-grid">
      ${roField("Date de visite", fmtDate(m.dateVisite||m.dateDebut))}
      ${roField("Entreprise visitée", escapeHtml(m.entreprise||"—"))}
      ${roField("Lieu / commune", escapeHtml(m.lieu||"—"))}
      ${roField("Responsable de mission", escapeHtml(m.responsable||"—"))}
    </div>
    <div class="form-section-title">Produits prélevés</div>
    ${produitsTableHtml(produits)}
    ${m.observations ? `<div class="form-section-title">Autres informations</div><p style="white-space:pre-wrap;">${escapeHtml(m.observations)}</p>` : ""}
    `,
    ficheFoot()
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openMissionForm(m.id));
  });
}

function populateSecteurFilter(){
  const sel = document.getElementById("missionFilterSecteur");
  const current = sel.value;
  sel.innerHTML = `<option value="">Tous secteurs</option>` + state.secteurs.map(s=>`<option ${s===current?"selected":""}>${escapeHtml(s)}</option>`).join("");
}

// Regroupe les visites (enregistrements missions) partageant la même période et le même objet,
// pour représenter une "mission" au sens large pouvant comporter plusieurs visites d'entreprises.
function missionGroupKey(m){
  return `${m.dateDebut}|${m.dateFin}|${(m.objet||"").trim().toLowerCase()}|${m.secteur||""}`;
}
function groupMissionsList(list){
  const groups = {};
  list.forEach(m=>{
    const key = missionGroupKey(m);
    if(!groups[key]) groups[key] = { key, dateDebut:m.dateDebut, dateFin:m.dateFin, objet:m.objet, secteur:m.secteur, statut:m.statut, members:[] };
    groups[key].members.push(m);
  });
  function maxVisite(group){
    return group.members.reduce((max,m)=>{
      const v = m.dateVisite || m.dateDebut || "";
      return v > max ? v : max;
    }, "");
  }
  return Object.values(groups).sort((a,b)=> maxVisite(b).localeCompare(maxVisite(a)));
}
function groupNbEntreprises(group){
  return new Set(group.members.map(m=>(m.entreprise||"").trim().toLowerCase()).filter(Boolean)).size;
}
function groupNbEchantillons(group){
  return group.members.reduce((sum,m)=> sum + state.echantillons.filter(e=>e.missionId===m.id).reduce((s,e)=> s + ((e.produits&&e.produits.length)?e.produits.length:(e.produit?1:0)), 0), 0);
}

function openMissionGroupFiche(key){
  const group = groupMissionsList(state.missions).find(g=>g.key===key);
  if(!group) return;
  const statutLabel = group.members[0].statut === "Non-programmée" && group.members[0].statutAutre ? `${group.members[0].statut} — ${group.members[0].statutAutre}` : group.statut;
  const visites = group.members.slice().sort((a,b)=>(b.dateVisite||b.dateDebut||"").localeCompare(a.dateVisite||a.dateDebut||""));

  const html = drawerShell(
    `Fiche mission — ${escapeHtml(group.objet||"Sans objet")}`,
    `
    <div class="form-section-title">Mission</div>
    <div class="field-grid">
      ${roField("Date de début", fmtDate(group.dateDebut))}
      ${roField("Date de fin", fmtDate(group.dateFin))}
      ${roField("Statut", `<span class="badge ${STATUT_MISSION_BADGE[group.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(statutLabel||"—")}</span>`)}
      ${roField("Objet de la mission", escapeHtml(group.objet||"—"))}
      ${roField("Secteur d'activité", escapeHtml(group.secteur||"—"))}
    </div>
    <div class="form-section-title">Visites (${visites.length})</div>
    <div id="groupVisitesList"></div>
    `,
    `<button class="btn" id="btnFicheAnalyzeIa" title="Demander à l'IA d'analyser et d'interpréter cette fiche">✨ Analyser avec l'IA</button><div style="flex:1"></div><button class="btn" id="drawerCancel">Fermer</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    const box = document.getElementById("groupVisitesList");
    box.innerHTML = visites.map(m=>{
      const nbEch = state.echantillons.filter(e=>e.missionId===m.id).reduce((s,e)=> s + ((e.produits&&e.produits.length)?e.produits.length:(e.produit?1:0)), 0);
      return `
      <div class="activity-item" data-open-visite="${m.id}" style="cursor:pointer;">
        <div class="activity-body">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div>
              <div class="title">${escapeHtml(m.entreprise)}</div>
              <div class="meta">Visité le ${fmtDate(m.dateVisite||m.dateDebut)} · ${escapeHtml(m.lieu||"Lieu non précisé")}</div>
            </div>
            <span class="badge badge-neutral"><span class="badge-dot"></span>${nbEch} échantillon${nbEch>1?"s":""}</span>
          </div>
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-open-visite]").forEach(row=>{
      row.addEventListener("click", ()=>{ closeDrawer(); openMissionFiche(row.dataset.openVisite); });
    });
  });
}

/* =========================================================================
   TRI DYNAMIQUE DES TABLEAUX (générique, réutilisable)
   Clic sur un en-tête portant data-sort-key="..." pour trier la colonne ;
   nouveau clic pour inverser le sens. Un petit indicateur (▲▼) montre le
   tri actif.
   ========================================================================= */

function attachSortableHeaders(tableId, sortState, rerenderFn){
  const table = document.getElementById(tableId);
  if(!table) return;
  table.querySelectorAll("thead th[data-sort-key]").forEach(th=>{
    if(!th.querySelector(".sort-arrow")) th.insertAdjacentHTML("beforeend", `<span class="sort-arrow"></span>`);
    const active = sortState.key === th.dataset.sortKey;
    th.classList.toggle("sort-active", active);
    th.querySelector(".sort-arrow").textContent = active ? (sortState.dir===1 ? "▲" : "▼") : "↕";
    th.onclick = ()=>{
      const key = th.dataset.sortKey;
      if(sortState.key === key) sortState.dir *= -1;
      else { sortState.key = key; sortState.dir = 1; }
      rerenderFn();
    };
  });
}

// Comparateur générique : gère nombres, dates (chaînes ISO) et texte, insensible à la casse.
function sortCompare(a, b, dir){
  if(a==null && b==null) return 0;
  if(a==null) return 1;
  if(b==null) return -1;
  if(typeof a === "number" && typeof b === "number") return (a-b)*dir;
  const sa = String(a).toLowerCase(), sb = String(b).toLowerCase();
  return sa.localeCompare(sb) * dir;
}

let missionsSortState = { key:null, dir:1 };

function renderMissions(){
  populateSecteurFilter();
  const q = (document.getElementById("missionSearch").value||"").toLowerCase();
  const fStatut = document.getElementById("missionFilterStatut").value;
  const fSecteur = document.getElementById("missionFilterSecteur").value;

  let list = state.missions.slice();
  list = list.filter(m => {
    if(fStatut && m.statut !== fStatut) return false;
    if(fSecteur && m.secteur !== fSecteur) return false;
    if(q){
      const hay = `${m.entreprise} ${m.lieu} ${m.responsable} ${m.ref} ${m.objet}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });

  let groups = groupMissionsList(list);
  if(missionsSortState.key){
    const k = missionsSortState.key, dir = missionsSortState.dir;
    groups = groups.slice().sort((a,b)=>{
      const va = k==="nbEntreprises" ? groupNbEntreprises(a) : k==="nbEchantillons" ? groupNbEchantillons(a) : a[k];
      const vb = k==="nbEntreprises" ? groupNbEntreprises(b) : k==="nbEchantillons" ? groupNbEchantillons(b) : b[k];
      return sortCompare(va, vb, dir);
    });
  }

  const tbody = document.getElementById("missionsTableBody");
  const tfoot = document.getElementById("missionsTableFoot");
  const missionsCountEl = document.getElementById("missionsResultCount");
  if(missionsCountEl) missionsCountEl.innerHTML = `<b>${groups.length}</b> mission${groups.length>1?"s":""} affichée${groups.length>1?"s":""}`;
  attachSortableHeaders("missionsTable", missionsSortState, renderMissions);
  if(!groups.length){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Aucune mission ne correspond aux critères. Créez-en une avec « Nouvelle mission ».</td></tr>`;
    tfoot.innerHTML = "";
    return;
  }
  tbody.innerHTML = groups.map(g => {
    return `
    <tr data-open-group="${g.key}" style="cursor:pointer;">
      <td class="mono">${fmtDate(g.dateDebut)}</td>
      <td class="mono">${fmtDate(g.dateFin)}</td>
      <td>${escapeHtml(g.objet||"—")}</td>
      <td class="mono">${groupNbEntreprises(g)}</td>
      <td class="mono">${groupNbEchantillons(g)}</td>
      <td><div class="row-actions">
        <button class="icon-btn" data-view-group="${g.key}" title="Voir la fiche">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div></td>
    </tr>`;
  }).join("");

  const totalEntreprises = groups.reduce((sum,g)=> sum + groupNbEntreprises(g), 0);
  const totalEchantillons = groups.reduce((sum,g)=> sum + groupNbEchantillons(g), 0);
  tfoot.innerHTML = `
    <tr>
      <td colspan="3">Total (${groups.length} mission${groups.length>1?"s":""})</td>
      <td class="mono">${totalEntreprises}</td>
      <td class="mono">${totalEchantillons}</td>
      <td></td>
    </tr>`;

  tbody.querySelectorAll("[data-open-group]").forEach(row=>{
    row.addEventListener("click", (ev)=>{
      if(ev.target.closest("[data-view-group]")) return;
      openMissionGroupFiche(row.dataset.openGroup);
    });
  });
  tbody.querySelectorAll("[data-view-group]").forEach(btn=>{
    btn.addEventListener("click", ()=> openMissionGroupFiche(btn.dataset.viewGroup));
  });
}

document.getElementById("btnNewMission").addEventListener("click", ()=> openMissionForm(null));
document.getElementById("missionSearch").addEventListener("input", renderMissions);
document.getElementById("missionFilterStatut").addEventListener("change", renderMissions);
document.getElementById("missionFilterSecteur").addEventListener("change", renderMissions);

// Onglets internes "Missions de contrôle" / "Échantillons & analyses"
(function bindMissionsTabs(){
  const view = document.getElementById("view-missions");
  const tabs = view.querySelectorAll("[data-comm-tab]");
  tabs.forEach(tab=>{
    tab.addEventListener("click", ()=>{
      tabs.forEach(t=> t.classList.toggle("active", t===tab));
      view.querySelectorAll("[data-comm-panel]").forEach(p=> p.hidden = p.dataset.commPanel !== tab.dataset.commTab);
    });
  });
})();

/* =========================================================================
   ÉCHANTILLONS & ANALYSES
   ========================================================================= */

const STATUT_ECH_BADGE = { "En attente":"badge-warn", "Conforme":"badge-success", "Non conforme":"badge-danger" };

function productRowHtml(p){
  p = p || {};
  const statutPhysico = p.statutPhysico || p.statut || "En attente";
  const statutMicro = p.statutMicro || p.statut || "En attente";
  return `
  <div class="product-row" data-product-row>
    <div class="product-row-fields">
      <div><label>Nom du produit prélevé</label><input type="text" value="${escapeHtml(p.nom||"")}" data-pr-nom placeholder="Ex : Riz parfumé 25kg"></div>
      <div><label>Date de production</label><input type="date" value="${p.dateProduction||""}" data-pr-dateprod></div>
      <div><label>Date de péremption</label><input type="date" value="${p.dateExpiration||""}" data-pr-dateexp></div>
      <div><label>Numéro de lot</label><input type="text" value="${escapeHtml(p.numeroLot||"")}" data-pr-lot placeholder="Ex : L240A"></div>
      <button class="icon-btn" data-remove-product title="Retirer">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="field-grid" style="margin-bottom:0;">
      <div class="field" style="margin-bottom:0;">
        <label>Conclusion de conformité physicochimique</label>
        <select data-pr-statut-physico>
          ${["En attente","Conforme","Non conforme"].map(s=>`<option ${statutPhysico===s?"selected":""}>${s}</option>`).join("")}
        </select>
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Conclusion de conformité microbiologique</label>
        <select data-pr-statut-micro>
          ${["En attente","Conforme","Non conforme"].map(s=>`<option ${statutMicro===s?"selected":""}>${s}</option>`).join("")}
        </select>
      </div>
    </div>
  </div>`;
}

// Conformité globale d'un produit : combine ses deux conclusions (physicochimique et microbiologique).
function computeProduitStatut(p){
  const a = p.statutPhysico || "En attente", b = p.statutMicro || "En attente";
  if(a==="Non conforme" || b==="Non conforme") return "Non conforme";
  if(a==="Conforme" && b==="Conforme") return "Conforme";
  return "En attente";
}

// Calcule le statut global de l'échantillon à partir des conclusions par produit :
// un seul produit non conforme rend l'ensemble non conforme ; il faut que tous les
// produits soient conformes (physicochimique ET microbiologique) pour que l'ensemble le soit.
function computeEchStatut(produits){
  if(!produits || !produits.length) return "En attente";
  const statuts = produits.map(computeProduitStatut);
  if(statuts.some(s=>s==="Non conforme")) return "Non conforme";
  if(statuts.every(s=>s==="Conforme")) return "Conforme";
  return "En attente";
}

function produitsResume(e){
  const list = (e.produits && e.produits.length) ? e.produits : (e.produit ? [{nom:e.produit}] : []);
  return list.map(p=>p.nom).filter(Boolean).join(", ") || "—";
}

function openEchForm(id, prefillMissionId){
  const e = id ? state.echantillons.find(x=>x.id===id) : null;
  const produits = (e?.produits && e.produits.length) ? e.produits : [];
  const linkedMissionId = e?.missionId || prefillMissionId || "";
  const linkedMission = linkedMissionId ? state.missions.find(x=>x.id===linkedMissionId) : null;

  const html = drawerShell(
    e ? `Modifier l'échantillon ${escapeHtml(e.ref)}` : "Nouveau prélèvement d'échantillon",
    `
    <div class="form-section-title">Prélèvement</div>
    <div class="field-grid">
      <div class="field"><label>Date de prélèvement</label><input type="date" id="f_dateprel" value="${e?.datePrelevement || todayISO()}"></div>
      <div class="field"><label>Mission liée</label><select id="f_mission">${missionOptions(linkedMissionId)}</select></div>
      <div class="field"><label>Entreprise</label><input type="text" id="f_ech_entreprise" value="${escapeHtml(e?.entreprise || linkedMission?.entreprise || "")}" placeholder="Auto si mission liée"></div>
      <div class="field"><label>Date de résultats (labo)</label><input type="date" id="f_dateresultat" value="${e?.dateResultat||""}"></div>
    </div>

    <div class="form-section-title">Produits prélevés</div>
    <div id="productList">${produits.map(productRowHtml).join("") || productRowHtml()}</div>
    <button class="btn btn-sm" id="btnAddProduct" type="button" style="margin-bottom:6px;">+ Ajouter un autre échantillon</button>

    <div class="field" style="margin-top:14px;"><label>Observations du laboratoire</label><textarea id="f_obslabo" rows="3" placeholder="Commentaires…" spellcheck="true">${escapeHtml(e?.observationsLabo||"")}</textarea></div>

    <div class="form-section-title">Conclusion de conformité</div>
    <p class="text-muted" style="font-size:12.5px; margin-top:-6px;">Une conclusion physicochimique et une conclusion microbiologique sont renseignées individuellement pour chaque produit prélevé ci-dessus. Le statut global de l'échantillon est calculé automatiquement : non conforme si au moins un produit l'est (sur l'un ou l'autre volet), conforme uniquement si tous les produits sont conformes sur les deux volets.</p>
    <div class="field" id="f_ech_statut_apercu"></div>

    ${attachmentsSectionHtml(e)}
    `,
    `
    ${e ? `<button class="btn btn-danger" id="btnDeleteEch">Supprimer</button>` : ""}
    <div style="flex:1"></div>
    <button class="btn" id="drawerCancel">Annuler</button>
    <button class="btn btn-primary" id="btnSaveEch">${e?"Enregistrer les modifications":"Enregistrer le prélèvement"}</button>
    `
  );

  openDrawer(html, () => {
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(e);

    const productList = document.getElementById("productList");
    function bindRemoveProduct(){
      productList.querySelectorAll("[data-remove-product]").forEach(b=>{
        b.onclick = () => { if(productList.children.length>1) b.closest("[data-product-row]").remove(); else b.closest("[data-product-row]").querySelectorAll("input").forEach(i=>i.value=""); refreshStatutApercu(); };
      });
      productList.querySelectorAll("[data-pr-statut-physico], [data-pr-statut-micro]").forEach(sel=>{
        sel.onchange = refreshStatutApercu;
      });
    }
    function collectProductsFromForm(){
      return [...productList.querySelectorAll("[data-product-row]")].map(row => ({
        id: row.dataset.prodId || uid("prod"),
        nom: row.querySelector("[data-pr-nom]").value.trim(),
        dateProduction: row.querySelector("[data-pr-dateprod]").value,
        dateExpiration: row.querySelector("[data-pr-dateexp]").value,
        numeroLot: row.querySelector("[data-pr-lot]").value.trim(),
        statutPhysico: row.querySelector("[data-pr-statut-physico]").value,
        statutMicro: row.querySelector("[data-pr-statut-micro]").value,
      })).filter(p => p.nom || p.dateProduction || p.dateExpiration || p.numeroLot);
    }
    function refreshStatutApercu(){
      const computed = computeEchStatut(collectProductsFromForm());
      document.getElementById("f_ech_statut_apercu").innerHTML =
        `<label>Statut global de l'échantillon</label><span class="badge ${STATUT_ECH_BADGE[computed]||"badge-neutral"}" style="font-size:13px; padding:6px 12px;"><span class="badge-dot"></span>${escapeHtml(computed)}</span>`;
    }
    bindRemoveProduct();
    refreshStatutApercu();
    document.getElementById("btnAddProduct").addEventListener("click", ()=>{
      productList.insertAdjacentHTML("beforeend", productRowHtml());
      bindRemoveProduct();
      refreshStatutApercu();
    });

    // auto-fill entreprise from selected mission
    document.getElementById("f_mission").addEventListener("change", (ev)=>{
      const mid = ev.target.value;
      const mis = state.missions.find(x=>x.id===mid);
      const entField = document.getElementById("f_ech_entreprise");
      if(mis && !entField.value.trim()) entField.value = mis.entreprise;
    });

    document.getElementById("btnSaveEch").addEventListener("click", () => {
      const produitsData = collectProductsFromForm();

      if(!produitsData.length){ toast("Veuillez indiquer au moins un produit prélevé."); return; }

      const data = {
        datePrelevement: document.getElementById("f_dateprel").value || todayISO(),
        missionId: document.getElementById("f_mission").value,
        produits: produitsData,
        entreprise: document.getElementById("f_ech_entreprise").value.trim(),
        dateResultat: document.getElementById("f_dateresultat").value,
        observationsLabo: document.getElementById("f_obslabo").value.trim(),
        statut: computeEchStatut(produitsData),
      };

      if(e){
        Object.assign(e, data);
        toast("Échantillon mis à jour.");
      } else {
        state.echantillons.push({ id: uid("ech"), ref: nextRef("echantillon"), ...data, pieceJointes: consumePendingAttachments() });
        toast("Prélèvement enregistré.");
      }
      saveState(); closeDrawer(); renderEchantillons(); renderDashboard(); updateBellUI();
    });

    document.getElementById("btnDeleteEch")?.addEventListener("click", async () => {
      if(!await appConfirm("Supprimer définitivement cet échantillon ?")) return;
      state.echantillons = state.echantillons.filter(x=>x.id!==e.id);
      saveState(); closeDrawer(); renderEchantillons(); updateBellUI();
      toast("Échantillon supprimé.");
    });
  });
}

let echSortState = { key:null, dir:1 };

function renderEchantillons(){
  const q = (document.getElementById("echSearch").value||"").toLowerCase();
  const fStatut = document.getElementById("echFilterStatut").value;

  let list = state.echantillons.slice().sort((a,b)=> (b.datePrelevement||"").localeCompare(a.datePrelevement||""));
  list = list.filter(e => {
    if(fStatut && e.statut !== fStatut) return false;
    if(q){
      const hay = `${produitsResume(e)} ${e.entreprise} ${e.ref}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });

  if(echSortState.key){
    const k = echSortState.key, dir = echSortState.dir;
    list = list.slice().sort((a,b)=>{
      const missionA = state.missions.find(m=>m.id===a.missionId);
      const missionB = state.missions.find(m=>m.id===b.missionId);
      const va = k==="produit" ? produitsResume(a) : k==="missionObjet" ? (missionA?.objet||"") : a[k];
      const vb = k==="produit" ? produitsResume(b) : k==="missionObjet" ? (missionB?.objet||"") : b[k];
      return sortCompare(va, vb, dir);
    });
  }

  const tbody = document.getElementById("echTableBody");
  const echCountEl = document.getElementById("echResultCount");
  if(echCountEl) echCountEl.innerHTML = `<b>${list.length}</b> échantillon${list.length>1?"s":""} affiché${list.length>1?"s":""}`;
  attachSortableHeaders("echTable", echSortState, renderEchantillons);
  if(!list.length){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Aucun échantillon ne correspond aux critères. Ajoutez un prélèvement avec « Nouveau prélèvement ».</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(e => {
    const mission = state.missions.find(m=>m.id===e.missionId);
    const nonConforme = e.statut === "Non conforme";
    return `
    <tr data-open-ech="${e.id}" style="cursor:pointer;" class="${nonConforme?"row-nonconforme":""}">
      <td><strong>${escapeHtml(produitsResume(e))}</strong></td>
      <td>${escapeHtml(e.entreprise||"—")}</td>
      <td>${mission ? escapeHtml(mission.objet||"—") : "—"}</td>
      <td>${fmtDate(e.datePrelevement)}</td>
      <td><span class="badge ${STATUT_ECH_BADGE[e.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(e.statut||"—")}</span></td>
      <td><div class="row-actions">
        <button class="icon-btn" data-view-ech="${e.id}" title="Voir la fiche">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="icon-btn" data-edit-ech="${e.id}" title="Modifier">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
      </div></td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-open-ech]").forEach(row=>{
    row.addEventListener("click", (ev)=>{
      if(ev.target.closest("[data-edit-ech]") || ev.target.closest("[data-view-ech]")) return;
      openEchFiche(row.dataset.openEch);
    });
  });
  tbody.querySelectorAll("[data-edit-ech]").forEach(btn=> btn.addEventListener("click", ()=> openEchForm(btn.dataset.editEch)));
  tbody.querySelectorAll("[data-view-ech]").forEach(btn=> btn.addEventListener("click", ()=> openEchFiche(btn.dataset.viewEch)));
}

function produitsTableHtml(produits){
  if(!produits || !produits.length) return `<p class="text-muted">Aucun produit enregistré.</p>`;
  return `
    <div class="table-wrap" style="margin-top:8px;">
      <table>
        <thead><tr><th>Nom du produit</th><th>Date de production</th><th>Date de péremption</th><th>Numéro de lot</th><th>Conclusion physicochimique</th><th>Conclusion microbiologique</th></tr></thead>
        <tbody>${produits.map(p=>{
          const stP = p.statutPhysico || p.statut || "En attente";
          const stM = p.statutMicro || p.statut || "En attente";
          const nonConf = stP==="Non conforme" || stM==="Non conforme";
          return `<tr class="${nonConf?'row-nonconforme':''}"><td>${escapeHtml(p.nom||"—")}</td><td class="mono">${p.dateProduction?fmtDate(p.dateProduction):"—"}</td><td class="mono">${p.dateExpiration?fmtDate(p.dateExpiration):"—"}</td><td class="mono">${escapeHtml(p.numeroLot||"—")}</td><td><span class="badge ${STATUT_ECH_BADGE[stP]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(stP)}</span></td><td><span class="badge ${STATUT_ECH_BADGE[stM]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(stM)}</span></td></tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
}

function openEchFiche(id){
  const e = state.echantillons.find(x=>x.id===id);
  if(!e) return;
  const mission = state.missions.find(m=>m.id===e.missionId);
  const sealClass = e.statut === "Conforme" ? "conforme" : e.statut === "Non conforme" ? "nonconforme" : "attente";
  const sealLabel = e.statut === "Conforme" ? "Conforme" : e.statut === "Non conforme" ? "Non<br>conforme" : "En<br>attente";
  const produits = (e.produits && e.produits.length) ? e.produits : (e.produit ? [{nom:e.produit}] : []);

  const html = drawerShell(
    `Fiche échantillon ${escapeHtml(e.ref)}`,
    `
    <div style="display:flex; gap:18px; align-items:center; margin-bottom:18px;">
      <div class="seal ${sealClass}"><div class="seal-text">${sealLabel}</div></div>
      <div>
        <div style="font-family:'Fraunces',serif; font-size:19px; font-weight:600;">${escapeHtml(produitsResume(e))}</div>
        <div class="text-muted" style="font-size:13px; margin-top:2px;">${escapeHtml(e.entreprise||"Entreprise non renseignée")}</div>
        <div class="text-muted" style="font-size:12px; margin-top:6px;">Prélevé le ${fmtDate(e.datePrelevement)} ${e.dateResultat ? "· Résultats le "+fmtDate(e.dateResultat) : ""}</div>
      </div>
    </div>
    <div class="field-grid">
      <div><label>Mission liée</label><div>${mission ? escapeHtml(mission.objet||"—") : "Aucune"}</div></div>
      <div><label>Statut</label><span class="badge ${STATUT_ECH_BADGE[e.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(e.statut)}</span></div>
    </div>
    <div class="form-section-title">Produits prélevés</div>
    ${produitsTableHtml(produits)}
    ${e.observationsLabo ? `<div class="form-section-title">Observations du laboratoire</div><p style="white-space:pre-wrap;">${escapeHtml(e.observationsLabo)}</p>` : ""}
    `,
    `<button class="btn" id="btnFicheAnalyzeIa" title="Demander à l'IA d'analyser et d'interpréter cette fiche">✨ Analyser avec l'IA</button><div style="flex:1"></div><button class="btn" id="drawerCancel">Fermer</button><button class="btn btn-primary" id="btnFicheEdit">Modifier</button>`
  );
  openDrawer(html, () => {
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openEchForm(e.id));
  });
}

document.getElementById("btnNewEch").addEventListener("click", ()=> openEchForm(null));
document.getElementById("echSearch").addEventListener("input", renderEchantillons);
document.getElementById("echFilterStatut").addEventListener("change", renderEchantillons);

/* =========================================================================
   SÉLECTEUR MULTIPLE DE PARTICIPANTS (basé sur les responsables enregistrés
   dans Données & export)
   ========================================================================= */

// Sépare une chaîne "participants" existante en { checked: [...noms connus], autres: "texte libre restant" }
function splitParticipants(str){
  const names = (str||"").split(",").map(s=>s.trim()).filter(Boolean);
  const checked = names.filter(n => state.responsables.includes(n));
  const autres = names.filter(n => !state.responsables.includes(n));
  return { checked, autres: autres.join(", ") };
}

function multiSelectParticipantsHtml(fieldId, existingValue){
  const { checked, autres } = splitParticipants(existingValue);
  const options = state.responsables;
  return `
    <div class="field">
      <label>Participants</label>
      ${options.length ? `
      <div class="multi-select" id="${fieldId}_box">
        ${options.map(o=>`<label class="ms-option"><input type="checkbox" value="${escapeHtml(o)}" ${checked.includes(o)?"checked":""}> ${escapeHtml(o)}</label>`).join("")}
      </div>` : `<p class="text-muted" style="font-size:12px; margin:4px 0;">Aucun responsable enregistré — ajoutez des noms dans « Données &amp; export ».</p>`}
      <input type="text" id="${fieldId}_autres" value="${escapeHtml(autres)}" placeholder="Autres participants non listés (séparés par une virgule)" style="margin-top:8px;">
    </div>`;
}

function collectParticipants(fieldId){
  const box = document.getElementById(fieldId+"_box");
  const checked = box ? [...box.querySelectorAll("input[type=checkbox]:checked")].map(i=>i.value) : [];
  const autres = (document.getElementById(fieldId+"_autres").value||"").split(",").map(s=>s.trim()).filter(Boolean);
  return [...checked, ...autres].join(", ");
}

/* =========================================================================
   ACTIVITÉS (réunions, ateliers, séminaires…)
   ========================================================================= */

function openActForm(id, prefillFrom){
  const a = id ? state.activites.find(x=>x.id===id) : null;
  const p = a || prefillFrom || null;
  const html = drawerShell(
    a ? "Modifier l'activité" : (prefillFrom ? `Dupliquer « ${escapeHtml(prefillFrom.titre)} »` : "Nouvelle activité"),
    `
    <div class="field-grid">
      <div class="field"><label>Type</label>
        <select id="f_act_type">${["Réunion","Atelier","Séminaire","Formation","Autre"].map(t=>`<option ${p?.type===t?"selected":""}>${t}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Date</label><input type="date" id="f_act_date" value="${prefillFrom ? todayISO() : (p?.date||todayISO())}"></div>
    </div>
    <div class="field"><label>Titre / objet</label><input type="text" id="f_act_titre" value="${escapeHtml(p?.titre||"")}" placeholder="Ex : Atelier de validation du plan de travail"></div>
    <div class="field"><label>Lieu</label><input type="text" id="f_act_lieu" value="${escapeHtml(p?.lieu||"")}" placeholder="Ex : Salle de conférence MCIA"></div>
    ${multiSelectParticipantsHtml("f_act_participants", p?.participants)}
    <div class="field"><label>Compte-rendu / notes</label><textarea id="f_act_notes" rows="6" placeholder="Points discutés, décisions, actions à suivre…" spellcheck="true">${escapeHtml(a?.notes||"")}</textarea></div>

    ${attachmentsSectionHtml(a)}
    `,
    `
    ${a ? `<button class="btn btn-danger" id="btnDeleteAct">Supprimer</button><button class="btn" id="btnDuplicateAct">Dupliquer</button>` : ""}
    <div style="flex:1"></div>
    <button class="btn" id="drawerCancel">Annuler</button>
    <button class="btn btn-primary" id="btnSaveAct">${a?"Enregistrer les modifications":"Enregistrer l'activité"}</button>
    `
  );
  openDrawer(html, () => {
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(a);
    document.getElementById("btnSaveAct").addEventListener("click", () => {
      const titre = document.getElementById("f_act_titre").value.trim();
      if(!titre){ toast("Veuillez indiquer un titre."); return; }
      const data = {
        type: document.getElementById("f_act_type").value,
        date: document.getElementById("f_act_date").value || todayISO(),
        titre,
        lieu: document.getElementById("f_act_lieu").value.trim(),
        participants: collectParticipants("f_act_participants"),
        notes: document.getElementById("f_act_notes").value.trim(),
      };
      let record = a;
      if(a){ Object.assign(a, data); toast("Activité mise à jour."); }
      else { record = { id: uid("act"), ...data, pieceJointes: consumePendingAttachments() }; state.activites.push(record); toast("Activité enregistrée."); }
      syncAutoRappel("activite", record.id, { date: record.date, titre: record.titre, lieu: record.lieu, type:"Réunion" });
      saveState(); closeDrawer(); renderActivites();
    });
    document.getElementById("btnDeleteAct")?.addEventListener("click", async () => {
      if(!await appConfirm("Supprimer cette activité ?")) return;
      removeAutoRappel("activite", a.id);
      state.activites = state.activites.filter(x=>x.id!==a.id);
      saveState(); closeDrawer(); renderActivites();
      toast("Activité supprimée.");
    });
    document.getElementById("btnDuplicateAct")?.addEventListener("click", () => {
      closeDrawer();
      openActForm(null, a);
      toast("Formulaire pré-rempli à partir de cette activité — modifiez puis enregistrez.");
    });
  });
}

const TYPE_ACT_BADGE = { "Réunion":"badge-neutral","Atelier":"badge-warn","Séminaire":"badge-success","Formation":"badge-success","Autre":"badge-neutral" };

function renderActivites(){
  const q = (document.getElementById("actSearch").value||"").toLowerCase();
  const fType = document.getElementById("actFilterType").value;
  let list = state.activites.slice().sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  list = list.filter(a=>{
    if(fType && a.type !== fType) return false;
    if(q && !`${a.titre} ${a.lieu} ${a.participants}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const container = document.getElementById("actList");
  if(!list.length){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/></svg>
      <div class="big">Aucune activité enregistrée</div>
      <div>Ajoutez une réunion, un atelier ou un séminaire avec « Nouvelle activité ».</div>
    </div>`;
    return;
  }
  container.innerHTML = list.map(a => {
    const ds = fmtDateShort(a.date);
    return `
    <div class="activity-item" data-open-act="${a.id}" style="cursor:pointer;">
      <div class="activity-date"><div class="d">${ds.d}</div><div class="m">${ds.m}</div></div>
      <div class="activity-body">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <div>
            <span class="badge ${TYPE_ACT_BADGE[a.type]||"badge-neutral"}" style="margin-bottom:4px;"><span class="badge-dot"></span>${escapeHtml(a.type)}</span>
            <div class="title">${escapeHtml(a.titre)}</div>
            <div class="meta">${escapeHtml(a.lieu||"Lieu non précisé")}${a.participants ? " · "+escapeHtml(a.participants) : ""}</div>
          </div>
          <div class="row-actions">
            <button class="icon-btn" data-edit-act="${a.id}" title="Modifier">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            </button>
          </div>
        </div>
        ${a.notes ? `<div class="notes">${escapeHtml(a.notes)}</div>` : ""}
      </div>
    </div>`;
  }).join("");
  container.querySelectorAll("[data-open-act]").forEach(card=>{
    card.addEventListener("click", (ev)=>{
      if(ev.target.closest("[data-edit-act]")) return;
      openActFiche(card.dataset.openAct);
    });
  });
  container.querySelectorAll("[data-edit-act]").forEach(btn=> btn.addEventListener("click", ()=> openActForm(btn.dataset.editAct)));
}

function openActFiche(id){
  const a = state.activites.find(x=>x.id===id);
  if(!a) return;
  const html = drawerShell(
    `Fiche activité — ${escapeHtml(a.titre)}`,
    `
    <div class="field-grid">
      ${roField("Type", `<span class="badge ${TYPE_ACT_BADGE[a.type]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(a.type)}</span>`)}
      ${roField("Date", fmtDate(a.date))}
      ${roField("Lieu", escapeHtml(a.lieu||"—"))}
      ${roField("Participants", escapeHtml(a.participants||"—"))}
    </div>
    <div class="form-section-title">Titre / objet</div>
    <p>${escapeHtml(a.titre)}</p>
    ${a.notes ? `<div class="form-section-title">Compte-rendu / notes</div><p style="white-space:pre-wrap;">${escapeHtml(a.notes)}</p>` : ""}
    `,
    ficheFoot()
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openActForm(a.id));
  });
}

document.getElementById("btnNewAct").addEventListener("click", ()=> openActForm(null));
document.getElementById("actSearch").addEventListener("input", renderActivites);
document.getElementById("actFilterType").addEventListener("change", renderActivites);

/* =========================================================================
   RÉUNION CODINORM
   ========================================================================= */

function openCodinormForm(id){
  const c = id ? state.reunionsCodinorm.find(x=>x.id===id) : null;
  const html = drawerShell(
    c ? "Modifier la réunion CODINORM" : "Nouvelle réunion CODINORM",
    `
    <div class="field-grid">
      <div class="field"><label>Date</label><input type="date" id="cod_date" value="${c?.date||todayISO()}"></div>
      <div class="field"><label>Lieu</label><input type="text" id="cod_lieu" value="${escapeHtml(c?.lieu||"")}" placeholder="Ex : Siège CODINORM"></div>
    </div>
    <div class="field"><label>Titre / objet de la réunion</label><input type="text" id="cod_titre" value="${escapeHtml(c?.titre||"")}" placeholder="Ex : Réunion de validation d'une norme"></div>
    <div class="field"><label>Norme(s) analysée(s)</label><input type="text" id="cod_norme" value="${escapeHtml(c?.normeAnalysee||"")}" placeholder="Ex : NI 4727:2025"></div>
    ${multiSelectParticipantsHtml("cod_participants", c?.participants)}
    <div class="field"><label>Ordre du jour</label><textarea id="cod_odj" rows="3" spellcheck="true">${escapeHtml(c?.ordreDuJour||"")}</textarea></div>
    <div class="field"><label>Décisions / points retenus</label><textarea id="cod_decisions" rows="4" spellcheck="true">${escapeHtml(c?.decisions||"")}</textarea></div>

    ${attachmentsSectionHtml(c)}
    `,
    `${c?`<button class="btn btn-danger" id="btnDeleteCodinorm">Supprimer</button>`:""}<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveCodinorm">${c?"Enregistrer":"Créer la réunion"}</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(c);
    document.getElementById("btnSaveCodinorm").addEventListener("click", ()=>{
      const titre = document.getElementById("cod_titre").value.trim();
      if(!titre){ toast("Veuillez indiquer un titre."); return; }
      const data = {
        date: document.getElementById("cod_date").value || todayISO(),
        lieu: document.getElementById("cod_lieu").value.trim(),
        titre,
        normeAnalysee: document.getElementById("cod_norme").value.trim(),
        participants: collectParticipants("cod_participants"),
        ordreDuJour: document.getElementById("cod_odj").value.trim(),
        decisions: document.getElementById("cod_decisions").value.trim(),
      };
      let record = c;
      if(c){ Object.assign(c, data); toast("Réunion mise à jour."); }
      else { record = { id: uid("cod"), ...data, pieceJointes: consumePendingAttachments() }; state.reunionsCodinorm.push(record); toast("Réunion CODINORM enregistrée."); }
      syncAutoRappel("codinorm", record.id, { date: record.date, titre: record.titre, lieu: record.lieu, type:"CODINORM" });
      saveState(); closeDrawer(); renderCodinorm(); renderDashboard();
    });
    document.getElementById("btnDeleteCodinorm")?.addEventListener("click", async ()=>{
      if(!await appConfirm("Supprimer cette réunion CODINORM ?")) return;
      removeAutoRappel("codinorm", c.id);
      state.reunionsCodinorm = state.reunionsCodinorm.filter(x=>x.id!==c.id);
      saveState(); closeDrawer(); renderCodinorm(); renderDashboard();
      toast("Réunion supprimée.");
    });
  });
}

function renderCodinorm(){
  const q = (document.getElementById("codinormSearch").value||"").toLowerCase();
  let list = state.reunionsCodinorm.slice().sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  list = list.filter(c=> !q || `${c.titre} ${c.lieu} ${c.participants} ${c.normeAnalysee||""}`.toLowerCase().includes(q));

  const container = document.getElementById("codinormList");
  if(!list.length){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/></svg>
      <div class="big">Aucune réunion CODINORM enregistrée</div>
      <div>Ajoutez-en une avec « Nouvelle réunion CODINORM ».</div>
    </div>`;
    return;
  }
  container.innerHTML = list.map(c=>{
    const ds = fmtDateShort(c.date);
    return `
    <div class="activity-item" data-open-codinorm="${c.id}" style="cursor:pointer;">
      <div class="activity-date"><div class="d">${ds.d}</div><div class="m">${ds.m}</div></div>
      <div class="activity-body">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <div>
            <div class="title">${escapeHtml(c.titre)}</div>
            <div class="meta">${escapeHtml(c.lieu||"Lieu non précisé")}${c.participants ? " · "+escapeHtml(c.participants) : ""}</div>
            ${c.normeAnalysee ? `<span class="badge badge-neutral" style="margin-top:4px;"><span class="badge-dot"></span>Norme : ${escapeHtml(c.normeAnalysee)}</span>` : ""}
          </div>
          <div class="row-actions">
            <button class="icon-btn" data-edit-codinorm="${c.id}" title="Modifier">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            </button>
          </div>
        </div>
        ${c.ordreDuJour ? `<div class="notes"><strong>Ordre du jour :</strong> ${escapeHtml(c.ordreDuJour)}</div>` : ""}
        ${c.decisions ? `<div class="notes"><strong>Décisions / points retenus :</strong> ${escapeHtml(c.decisions)}</div>` : ""}
      </div>
    </div>`;
  }).join("");
  container.querySelectorAll("[data-open-codinorm]").forEach(card=>{
    card.addEventListener("click", (ev)=>{
      if(ev.target.closest("[data-edit-codinorm]")) return;
      openCodinormFiche(card.dataset.openCodinorm);
    });
  });
  container.querySelectorAll("[data-edit-codinorm]").forEach(btn=> btn.addEventListener("click", ()=> openCodinormForm(btn.dataset.editCodinorm)));
}

function openCodinormFiche(id){
  const c = state.reunionsCodinorm.find(x=>x.id===id);
  if(!c) return;
  const html = drawerShell(
    `Fiche réunion CODINORM — ${escapeHtml(c.titre)}`,
    `
    <div class="field-grid">
      ${roField("Date", fmtDate(c.date))}
      ${roField("Lieu", escapeHtml(c.lieu||"—"))}
      ${roField("Norme(s) analysée(s)", escapeHtml(c.normeAnalysee||"—"))}
      ${roField("Participants", escapeHtml(c.participants||"—"))}
    </div>
    ${c.ordreDuJour ? `<div class="form-section-title">Ordre du jour</div><p style="white-space:pre-wrap;">${escapeHtml(c.ordreDuJour)}</p>` : ""}
    ${c.decisions ? `<div class="form-section-title">Décisions / points retenus</div><p style="white-space:pre-wrap;">${escapeHtml(c.decisions)}</p>` : ""}
    `,
    ficheFoot()
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openCodinormForm(c.id));
  });
}

document.getElementById("btnNewCodinorm").addEventListener("click", ()=> openCodinormForm(null));
document.getElementById("codinormSearch").addEventListener("input", renderCodinorm);

/* =========================================================================
   AGENDA & RAPPELS — activités à venir, rappels et alertes
   ========================================================================= */

const RAPPEL_TYPES = ["Mission","Réunion","CODINORM","Commission Retraitement Riz","Commission Tabac","Autre"];
const RAPPEL_DELAIS = [
  { value:0, label:"Le jour même" },
  { value:1, label:"1 jour avant" },
  { value:3, label:"3 jours avant" },
  { value:7, label:"1 semaine avant" },
  { value:14, label:"2 semaines avant" },
];
const STATUT_RAPPEL_BADGE = { "À venir":"badge-neutral", "Fait":"badge-success", "Annulé":"badge-danger" };

function daysUntil(dateStr){
  if(!dateStr) return null;
  const today = new Date(todayISO()+"T00:00:00");
  const target = new Date(dateStr+"T00:00:00");
  return Math.round((target-today)/86400000);
}

// Niveau d'urgence d'un rappel : "done" | "overdue" | "today" | "soon" | "normal"
function rappelUrgency(r){
  if(r.statut !== "À venir") return "done";
  const dl = daysUntil(r.date);
  if(dl === null) return "normal";
  if(dl < 0) return "overdue";
  if(dl === 0) return "today";
  if(dl <= (r.rappelJours ?? 3)) return "soon";
  return "normal";
}

// Insère automatiquement une activité "cochée fait" dans le module correspondant
// (Mission, Réunion, CODINORM, Commission Retraitement Riz/Tabac), pour éviter une double saisie.
function insertRappelIntoModule(r){
  if(r.insereDansModule) return false;
  if(r.auto) return false; // Rappel automatique : l'enregistrement source existe déjà dans son module, rien à dupliquer.
  const note = `Créé automatiquement depuis l'agenda (« ${r.titre} »).`;
  let inserted = true;
  switch(r.type){
    case "Mission":
      state.missions.push({
        id: uid("mis"), ref: nextRef("mission"),
        dateDebut: r.date, dateFin: r.date, statut: "Programmée", statutAutre: "",
        objet: r.titre, secteur: "",
        dateVisite: r.date, entreprise: r.titre, lieu: r.lieu||"", responsable: "",
        observations: [r.notes, note].filter(Boolean).join("\n\n"),
      });
      break;
    case "Réunion":
      state.activites.push({
        id: uid("act"), type: "Réunion", date: r.date, titre: r.titre, lieu: r.lieu||"",
        participants: "", notes: [r.notes, note].filter(Boolean).join("\n\n"),
      });
      break;
    case "CODINORM":
      state.reunionsCodinorm.push({
        id: uid("cod"), date: r.date, lieu: r.lieu||"", titre: r.titre, normeAnalysee: "",
        participants: "", ordreDuJour: "", decisions: [r.notes, note].filter(Boolean).join("\n\n"),
      });
      break;
    case "Commission Retraitement Riz":
      if(commData("riz")){
        commData("riz").sessions.push({
          id: uid("sess"), date: r.date, lieu: r.lieu||"", titre: r.titre,
          participants: "", ordreDuJour: "", decisions: [r.notes, note].filter(Boolean).join("\n\n"),
          structures: [],
        });
      } else { inserted = false; }
      break;
    case "Commission Tabac":
      if(commData("tabac")){
        commData("tabac").sessions.push({
          id: uid("sess"), date: r.date, lieu: r.lieu||"", titre: r.titre,
          participants: "", ordreDuJour: "", decisions: [r.notes, note].filter(Boolean).join("\n\n"),
          structures: [],
        });
      } else { inserted = false; }
      break;
    default:
      inserted = false; // "Autre" : pas de module correspondant, pas d'insertion automatique
  }
  if(inserted) r.insereDansModule = true;
  return inserted;
}

// Marque un rappel comme fait, l'insère automatiquement dans le module correspondant,
// puis le retire de l'agenda (l'information vit désormais dans son module d'origine).
function markRappelDone(r){
  if(r.statut === "Fait") return;
  r.statut = "Fait";
  const inserted = insertRappelIntoModule(r);
  state.rappels = state.rappels.filter(x=>x.id!==r.id);
  saveState();
  toast(inserted ? `Marqué comme fait — reclassé dans « ${r.type} ».` : "Marqué comme fait et retiré de l'agenda.");
}

// Rappels dont l'alerte est active (à afficher dans la cloche / notifications)
function activeAlerts(){
  return state.rappels.filter(r=>{
    if(r.statut !== "À venir") return false;
    const u = rappelUrgency(r);
    return u === "overdue" || u === "today" || u === "soon";
  }).sort((a,b)=> (a.date||"").localeCompare(b.date||""));
}

function openRappelForm(id){
  const r = id ? state.rappels.find(x=>x.id===id) : null;
  const html = drawerShell(
    r ? "Modifier l'activité à venir" : "Nouvelle activité à venir",
    `
    <div class="field-grid">
      <div class="field"><label>Type</label>
        <select id="rf_type">${RAPPEL_TYPES.map(t=>`<option ${(r?.type||"Autre")===t?"selected":""}>${t}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Statut</label>
        <select id="rf_statut">${["À venir","Fait","Annulé"].map(s=>`<option ${(r?.statut||"À venir")===s?"selected":""}>${s}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field"><label>Titre / objet</label><input type="text" id="rf_titre" value="${escapeHtml(r?.titre||"")}" placeholder="Ex : Mission de contrôle chez XYZ SARL"></div>
    <div class="field-grid">
      <div class="field"><label>Date</label><input type="date" id="rf_date" value="${r?.date||todayISO()}"></div>
      <div class="field"><label>Heure (optionnel)</label><input type="time" id="rf_heure" value="${r?.heure||""}"></div>
    </div>
    <div class="field"><label>Lieu</label><input type="text" id="rf_lieu" value="${escapeHtml(r?.lieu||"")}" placeholder="Ex : Yopougon, Abidjan"></div>
    <div class="field">
      <label>Rappel — être alerté</label>
      <select id="rf_delai">${RAPPEL_DELAIS.map(d=>`<option value="${d.value}" ${String(r?.rappelJours ?? 3)===String(d.value)?"selected":""}>${d.label}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Description / notes</label><textarea id="rf_notes" rows="4" placeholder="Détails complémentaires…" spellcheck="true">${escapeHtml(r?.notes||"")}</textarea></div>

    ${attachmentsSectionHtml(r)}
    `,
    `${r?`<button class="btn btn-danger" id="btnDeleteRappel">Supprimer</button>`:""}<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveRappel">${r?"Enregistrer":"Créer le rappel"}</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(r);
    document.getElementById("btnSaveRappel").addEventListener("click", ()=>{
      const titre = document.getElementById("rf_titre").value.trim();
      if(!titre){ toast("Veuillez indiquer un titre."); return; }
      const data = {
        type: document.getElementById("rf_type").value,
        statut: document.getElementById("rf_statut").value,
        titre,
        date: document.getElementById("rf_date").value || todayISO(),
        heure: document.getElementById("rf_heure").value,
        lieu: document.getElementById("rf_lieu").value.trim(),
        rappelJours: Number(document.getElementById("rf_delai").value),
        notes: document.getElementById("rf_notes").value.trim(),
      };
      if(r){ Object.assign(r, data); r.dernierRappelNotifie = null; toast("Rappel mis à jour."); }
      else { state.rappels.push({ id: uid("rap"), dernierRappelNotifie:null, ...data, pieceJointes: consumePendingAttachments() }); toast("Activité à venir enregistrée."); }
      const target = r || state.rappels[state.rappels.length-1];
      if(target.statut === "Fait" && !target.insereDansModule){
        const inserted = insertRappelIntoModule(target);
        state.rappels = state.rappels.filter(x=>x.id!==target.id);
        toast(inserted ? `Marqué comme fait — reclassé dans « ${target.type} ».` : "Marqué comme fait et retiré de l'agenda.");
      }
      saveState(); closeDrawer(); renderRappels(); renderDashboard(); updateBellUI();
    });
    document.getElementById("btnDeleteRappel")?.addEventListener("click", async ()=>{
      if(!await appConfirm("Supprimer ce rappel ?")) return;
      state.rappels = state.rappels.filter(x=>x.id!==r.id);
      saveState(); closeDrawer(); renderRappels(); renderDashboard(); updateBellUI();
      toast("Rappel supprimé.");
    });
  });
}

function rappelItemHtml(r){
  const urgency = rappelUrgency(r);
  const ds = fmtDateShort(r.date);
  const dl = daysUntil(r.date);
  let urgencyLabel = "";
  if(r.statut==="À venir"){
    if(urgency==="overdue") urgencyLabel = `<span class="badge badge-danger"><span class="badge-dot"></span>En retard</span>`;
    else if(urgency==="today") urgencyLabel = `<span class="badge badge-danger"><span class="badge-dot"></span>Aujourd'hui</span>`;
    else if(urgency==="soon") urgencyLabel = `<span class="badge badge-warn"><span class="badge-dot"></span>Dans ${dl} jour${dl>1?"s":""}</span>`;
  }
  return `
  <div class="rappel-item ${urgency==="overdue"||urgency==="today"?"urgent":urgency==="soon"?"soon":""} ${r.statut!=="À venir"?"done":""}" data-open-rappel="${r.id}" style="cursor:pointer;">
    <div class="activity-date"><div class="d">${ds.d}</div><div class="m">${ds.m}</div></div>
    <div class="activity-body">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div>
          <span class="badge badge-neutral" style="margin-bottom:4px;"><span class="badge-dot"></span>${escapeHtml(r.type)}</span>
          ${r.auto ? `<span class="badge badge-neutral" style="margin-bottom:4px;" title="Généré automatiquement depuis sa fiche d'origine">Auto</span>` : ""}
          ${urgencyLabel}
          <div class="title">${escapeHtml(r.titre)}</div>
          <div class="meta">${r.heure?escapeHtml(r.heure)+" · ":""}${escapeHtml(r.lieu||"Lieu non précisé")} · <span class="badge ${STATUT_RAPPEL_BADGE[r.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(r.statut)}</span></div>
        </div>
        <div class="row-actions">
          ${r.statut==="À venir" ? `<button class="icon-btn" data-done-rappel="${r.id}" title="Marquer comme fait">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l4.5 4.5L19 7"/></svg>
          </button>` : ""}
          <button class="icon-btn" data-edit-rappel="${r.id}" title="Modifier">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          </button>
        </div>
      </div>
      ${r.notes ? `<div class="notes">${escapeHtml(r.notes)}</div>` : ""}
    </div>
  </div>`;
}

function openRappelFiche(id){
  const r = state.rappels.find(x=>x.id===id);
  if(!r) return;
  const html = drawerShell(
    `Fiche activité à venir — ${escapeHtml(r.titre)}`,
    `
    <div class="field-grid">
      ${roField("Type", escapeHtml(r.type))}
      ${roField("Statut", `<span class="badge ${STATUT_RAPPEL_BADGE[r.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(r.statut)}</span>`)}
      ${roField("Date", fmtDate(r.date))}
      ${roField("Heure", escapeHtml(r.heure||"—"))}
      ${roField("Lieu", escapeHtml(r.lieu||"—"))}
      ${roField("Rappel", RAPPEL_DELAIS.find(d=>d.value===(r.rappelJours??3))?.label || "—")}
    </div>
    ${r.notes ? `<div class="form-section-title">Description / notes</div><p style="white-space:pre-wrap;">${escapeHtml(r.notes)}</p>` : ""}
    `,
    `${r.statut==="À venir" ? `<button class="btn" id="btnFicheDone">Marquer comme fait</button>` : ""}<button class="btn" id="btnFicheAnalyzeIa" title="Demander à l'IA d'analyser et d'interpréter cette fiche">✨ Analyser avec l'IA</button><div style="flex:1"></div><button class="btn" id="drawerCancel">Fermer</button><button class="btn btn-primary" id="btnFicheEdit">Modifier</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openRappelForm(r.id));
    document.getElementById("btnFicheDone")?.addEventListener("click", ()=>{
      markRappelDone(r); closeDrawer(); renderRappels(); renderDashboard(); updateBellUI();
    });
  });
}

function renderRappels(){
  const q = (document.getElementById("rappelSearch").value||"").toLowerCase();
  const fType = document.getElementById("rappelFilterType").value;
  const fStatut = document.getElementById("rappelFilterStatut").value;

  let list = state.rappels.slice().sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  list = list.filter(r=>{
    if(fType && r.type !== fType) return false;
    if(fStatut && r.statut !== fStatut) return false;
    if(q && !`${r.titre} ${r.lieu} ${r.notes}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const container = document.getElementById("rappelList");
  if(!list.length){
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <div class="big">Aucune activité à venir enregistrée</div>
      <div>Ajoutez-en une avec « Nouvelle activité à venir » pour recevoir un rappel.</div>
    </div>`;
    return;
  }
  container.innerHTML = list.map(rappelItemHtml).join("");
  container.querySelectorAll("[data-open-rappel]").forEach(card=>{
    card.addEventListener("click", (ev)=>{
      if(ev.target.closest("[data-edit-rappel]") || ev.target.closest("[data-done-rappel]")) return;
      openRappelFiche(card.dataset.openRappel);
    });
  });
  container.querySelectorAll("[data-edit-rappel]").forEach(btn=> btn.addEventListener("click", ()=> openRappelForm(btn.dataset.editRappel)));
  container.querySelectorAll("[data-done-rappel]").forEach(btn=> btn.addEventListener("click", ()=>{
    const r = state.rappels.find(x=>x.id===btn.dataset.doneRappel);
    if(r){ markRappelDone(r); renderRappels(); renderDashboard(); updateBellUI(); }
  }));
}

document.getElementById("btnNewRappel").addEventListener("click", ()=> openRappelForm(null));
document.getElementById("rappelSearch").addEventListener("input", renderRappels);
document.getElementById("rappelFilterType").addEventListener("change", renderRappels);
document.getElementById("rappelFilterStatut").addEventListener("change", renderRappels);

/* ---------------------------- Cloche / bande déroulante d'alertes ---------------------------- */

function toggleBellDropdown(force){
  const dd = document.getElementById("bellDropdown");
  const willShow = force !== undefined ? force : dd.hidden;
  dd.hidden = !willShow;
  if(willShow) renderBellDropdown();
}

document.getElementById("bellPill").addEventListener("click", (ev)=>{
  ev.stopPropagation();
  toggleBellDropdown();
});
document.addEventListener("click", (ev)=>{
  const dd = document.getElementById("bellDropdown");
  if(!dd.hidden && !ev.target.closest(".bell-wrap")) toggleBellDropdown(false);
});
document.querySelector(".bell-dropdown-foot").addEventListener("click", ()=> toggleBellDropdown(false));

function renderBellDropdown(){
  const alerts = activeAlerts();
  const pendingEch = state.echantillons.filter(e=> e.statut==="En attente" || !e.statut).length;
  const list = document.getElementById("bellDropdownList");
  if(!alerts.length && !pendingEch){
    list.innerHTML = `<div class="bell-dropdown-empty">Aucune alerte active pour le moment.</div>`;
    return;
  }
  const echItem = pendingEch ? `
    <div class="bell-dropdown-item soon" data-open-bell-ech="1">
      <span class="dot"></span>
      <div>
        <div class="bdi-title">${pendingEch} échantillon${pendingEch>1?"s":""} en attente de résultats</div>
        <div class="bdi-meta">Échantillons &amp; analyses · à finaliser</div>
      </div>
    </div>` : "";
  list.innerHTML = `<div class="bell-dropdown-list">` + echItem + alerts.slice(0,8).map(r=>{
    const u = rappelUrgency(r);
    const dl = daysUntil(r.date);
    const when = u==="overdue" ? "En retard" : u==="today" ? "Aujourd'hui" : `Dans ${dl} jour${dl>1?"s":""}`;
    return `
    <div class="bell-dropdown-item ${u==="overdue"||u==="today"?"urgent":"soon"}" data-open-bell-rappel="${r.id}">
      <span class="dot"></span>
      <div>
        <div class="bdi-title">${escapeHtml(r.titre)}</div>
        <div class="bdi-meta">${escapeHtml(r.type)} · ${when} · ${fmtDate(r.date)}</div>
      </div>
    </div>`;
  }).join("") + `</div>`;
  list.querySelectorAll("[data-open-bell-rappel]").forEach(item=>{
    item.addEventListener("click", ()=>{
      toggleBellDropdown(false);
      openRappelFiche(item.dataset.openBellRappel);
    });
  });
  list.querySelectorAll("[data-open-bell-ech]").forEach(item=>{
    item.addEventListener("click", ()=>{
      toggleBellDropdown(false);
      goView("missions");
      document.querySelector('#view-missions [data-comm-tab="liste-echantillons"]')?.click();
    });
  });
}

function updateBellUI(){
  const alerts = activeAlerts();
  const pendingEch = state.echantillons.filter(e=> e.statut==="En attente" || !e.statut).length;
  const total = alerts.length + (pendingEch ? 1 : 0);
  const badge = document.getElementById("bellBadge");
  const pill = document.getElementById("bellPill");
  if(total){
    badge.hidden = false;
    badge.textContent = total > 9 ? "9+" : total;
    pill.classList.add("has-alerts");
    pill.title = `${total} alerte(s) active(s)`;
  } else {
    badge.hidden = true;
    pill.classList.remove("has-alerts");
    pill.title = "Aucune alerte active";
  }
  const dd = document.getElementById("bellDropdown");
  if(!dd.hidden) renderBellDropdown();
}

// Notifications (bandeau + notification système) une fois par jour et par rappel
function checkRappelNotifications(){
  const alerts = activeAlerts();
  const today = todayISO();
  const toNotify = alerts.filter(r => r.dernierRappelNotifie !== today);
  if(!toNotify.length) return;

  toNotify.forEach(r => { r.dernierRappelNotifie = today; });
  saveState();

  const summary = toNotify.length === 1
    ? `Rappel : « ${toNotify[0].titre} » — ${toNotify[0].date===today?"aujourd'hui":fmtDate(toNotify[0].date)}`
    : `${toNotify.length} activités à venir nécessitent votre attention.`;
  toast(summary);

  if(typeof Notification !== "undefined"){
    const fire = () => {
      toNotify.slice(0,5).forEach(r=>{
        try{
          new Notification("SDCQN Suivi — Rappel", {
            body: `${r.titre}${r.lieu?" · "+r.lieu:""} — ${r.date===today?"aujourd'hui":fmtDate(r.date)}`,
            tag: "sdcqn-rappel-"+r.id,
          });
        }catch(e){ /* environnement sans notifications natives */ }
      });
    };
    if(Notification.permission === "granted") fire();
    else if(Notification.permission !== "denied"){
      Notification.requestPermission().then(p=>{ if(p==="granted") fire(); });
    }
  }
}

// Rappel quotidien du nombre d'échantillons en attente de résultats
const ECH_NOTIF_KEY = "sdcqn_ech_notif_date";
function checkEchantillonsEnAttenteNotification(){
  const pending = state.echantillons.filter(e=> e.statut==="En attente" || !e.statut).length;
  if(!pending) return;
  const today = todayISO();
  if(localStorage.getItem(ECH_NOTIF_KEY) === today) return;
  localStorage.setItem(ECH_NOTIF_KEY, today);
  toast(`Rappel : ${pending} échantillon${pending>1?"s":""} en attente de résultats.`);
  if(typeof Notification !== "undefined" && Notification.permission === "granted"){
    try{
      new Notification("SDCQN Suivi — Rappel", {
        body: `${pending} échantillon${pending>1?"s":""} en attente de résultats de laboratoire.`,
        tag: "sdcqn-ech-attente",
      });
    }catch(e){ /* environnement sans notifications natives */ }
  }
}

updateBellUI();
setTimeout(()=>{ checkRappelNotifications(); checkEchantillonsEnAttenteNotification(); }, 1200);
setInterval(()=>{ updateBellUI(); checkRappelNotifications(); checkEchantillonsEnAttenteNotification(); }, 5*60*1000);

/* =========================================================================
   BASE DE DONNÉES — répertoire des entreprises et structures
   ========================================================================= */

function openEntrepriseForm(id){
  const ent = id ? state.entreprises.find(x=>x.id===id) : null;
  const html = drawerShell(
    ent ? "Modifier l'entreprise" : "Nouvelle entreprise",
    `
    <div class="field"><label>Nom de l'entreprise</label><input type="text" id="ent_nom" value="${escapeHtml(ent?.nom||"")}" placeholder="Raison sociale"></div>
    <div class="field-grid">
      <div class="field"><label>Nom d'un représentant</label><input type="text" id="ent_representant" value="${escapeHtml(ent?.representant||"")}" placeholder="Ex : M. KOUAME Jean"></div>
      <div class="field"><label>Contact</label><input type="text" id="ent_contact" value="${escapeHtml(ent?.contact||"")}" placeholder="Téléphone ou e-mail"></div>
    </div>
    <div class="field-grid">
      <div class="field"><label>Localisation</label><input type="text" id="ent_localisation" value="${escapeHtml(ent?.localisation||"")}" placeholder="Ex : Yopougon, Abidjan"></div>
      <div class="field"><label>Secteur d'activité</label><select id="ent_secteur"><option value="">—</option>${secteurOptions(ent?.secteur)}</select></div>
    </div>
    <div class="field"><label>Autres informations</label><textarea id="ent_notes" rows="3" placeholder="Précisions complémentaires…" spellcheck="true">${escapeHtml(ent?.notes||"")}</textarea></div>

    ${attachmentsSectionHtml(ent)}
    `,
    `${ent?`<button class="btn btn-danger" id="btnDeleteEntreprise">Supprimer</button>`:""}<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveEntreprise">${ent?"Enregistrer":"Ajouter"}</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(ent);
    document.getElementById("btnSaveEntreprise").addEventListener("click", ()=>{
      const nom = document.getElementById("ent_nom").value.trim();
      if(!nom){ toast("Veuillez indiquer le nom de l'entreprise."); return; }
      const data = {
        nom,
        representant: document.getElementById("ent_representant").value.trim(),
        contact: document.getElementById("ent_contact").value.trim(),
        localisation: document.getElementById("ent_localisation").value.trim(),
        secteur: document.getElementById("ent_secteur").value,
        notes: document.getElementById("ent_notes").value.trim(),
      };
      if(ent){ Object.assign(ent, data); toast("Entreprise mise à jour."); }
      else { state.entreprises.push({ id: uid("ent"), ...data, pieceJointes: consumePendingAttachments() }); toast("Entreprise ajoutée."); }
      saveState(); closeDrawer(); renderEntreprises();
    });
    document.getElementById("btnDeleteEntreprise")?.addEventListener("click", async ()=>{
      if(!await appConfirm("Supprimer cette entreprise de la base de données ?")) return;
      state.entreprises = state.entreprises.filter(x=>x.id!==ent.id);
      saveState(); closeDrawer(); renderEntreprises();
      toast("Entreprise supprimée.");
    });
  });
}

function openEntrepriseFiche(id){
  const ent = state.entreprises.find(x=>x.id===id);
  if(!ent) return;
  const html = drawerShell(
    `Fiche entreprise — ${escapeHtml(ent.nom)}`,
    `
    <div class="field-grid">
      ${roField("Nom de l'entreprise", escapeHtml(ent.nom))}
      ${roField("Secteur d'activité", escapeHtml(ent.secteur||"—"))}
      ${roField("Représentant", escapeHtml(ent.representant||"—"))}
      ${roField("Contact", escapeHtml(ent.contact||"—"))}
      ${roField("Localisation", escapeHtml(ent.localisation||"—"))}
    </div>
    ${ent.notes ? `<div class="form-section-title">Autres informations</div><p style="white-space:pre-wrap;">${escapeHtml(ent.notes)}</p>` : ""}
    `,
    ficheFoot()
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openEntrepriseForm(ent.id));
  });
}

function populateEntrepriseSecteurFilter(){
  const sel = document.getElementById("entrepriseFilterSecteur");
  const current = sel.value;
  sel.innerHTML = `<option value="">Tous secteurs</option>` + state.secteurs.map(s=>`<option ${s===current?"selected":""}>${escapeHtml(s)}</option>`).join("");
}

let entreprisesSortState = { key:null, dir:1 };

function renderEntreprises(){
  populateEntrepriseSecteurFilter();
  const q = (document.getElementById("entrepriseSearch").value||"").toLowerCase();
  const fSecteur = document.getElementById("entrepriseFilterSecteur").value;

  let list = state.entreprises.slice().sort((a,b)=> (a.nom||"").localeCompare(b.nom||""));
  list = list.filter(ent=>{
    if(fSecteur && ent.secteur !== fSecteur) return false;
    if(q && !`${ent.nom} ${ent.representant} ${ent.contact} ${ent.localisation}`.toLowerCase().includes(q)) return false;
    return true;
  });

  if(entreprisesSortState.key){
    const k = entreprisesSortState.key, dir = entreprisesSortState.dir;
    list = list.slice().sort((a,b)=> sortCompare(a[k], b[k], dir));
  }

  const tbody = document.getElementById("entreprisesTableBody");
  const entreprisesCountEl = document.getElementById("entreprisesResultCount");
  if(entreprisesCountEl) entreprisesCountEl.innerHTML = `<b>${list.length}</b> entreprise${list.length>1?"s":""} affichée${list.length>1?"s":""}`;
  attachSortableHeaders("entreprisesTable", entreprisesSortState, renderEntreprises);
  if(!list.length){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Aucune entreprise enregistrée. Ajoutez-en une avec « Nouvelle entreprise ».</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(ent=>`
    <tr data-open-entreprise="${ent.id}" style="cursor:pointer;">
      <td><strong>${escapeHtml(ent.nom)}</strong></td>
      <td>${escapeHtml(ent.representant||"—")}</td>
      <td>${escapeHtml(ent.contact||"—")}</td>
      <td>${escapeHtml(ent.localisation||"—")}</td>
      <td>${escapeHtml(ent.secteur||"—")}</td>
      <td><div class="row-actions">
        <button class="icon-btn" data-view-entreprise="${ent.id}" title="Voir la fiche">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="icon-btn" data-edit-entreprise="${ent.id}" title="Modifier">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
      </div></td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-open-entreprise]").forEach(row=>{
    row.addEventListener("click", (ev)=>{
      if(ev.target.closest("[data-edit-entreprise]") || ev.target.closest("[data-view-entreprise]")) return;
      openEntrepriseFiche(row.dataset.openEntreprise);
    });
  });
  tbody.querySelectorAll("[data-view-entreprise]").forEach(btn=> btn.addEventListener("click", ()=> openEntrepriseFiche(btn.dataset.viewEntreprise)));
  tbody.querySelectorAll("[data-edit-entreprise]").forEach(btn=> btn.addEventListener("click", ()=> openEntrepriseForm(btn.dataset.editEntreprise)));
}

document.getElementById("btnNewEntreprise").addEventListener("click", ()=> openEntrepriseForm(null));
document.getElementById("entrepriseSearch").addEventListener("input", renderEntreprises);
document.getElementById("entrepriseFilterSecteur").addEventListener("change", renderEntreprises);

/* =========================================================================
   ARCHIVES — conserve les données d'une année sous forme de « photo »
   consultable à tout moment, puis repart à zéro pour la nouvelle année.
   Les données de référence (entreprises, secteurs, responsables, structure
   des commissions) NE sont PAS remises à zéro : seules
   les données d'activité de l'année (missions, échantillons, réunions,
   CODINORM, sessions et agréments des commissions, rappels) sont archivées
   puis vidées.
   ========================================================================= */

function deepClone(obj){
  return typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
}

function renderArchives(){
  const el = document.getElementById("view-archives");
  const years = state.archives.slice().sort((a,b)=> b.annee - a.annee);
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>Archiver l'année en cours</h3></div>
      <p class="text-muted">Conserve définitivement toutes les missions, échantillons, réunions, CODINORM, sessions et agréments de commissions, et rappels actuellement enregistrés — puis vide ces modules pour repartir à zéro. Les fichiers déjà partagés sur le serveur/Google restent accessibles normalement. La base d'entreprises et la structure des commissions ne sont pas affectées.</p>
      <div class="field-grid">
        <div class="field"><label>Année à archiver</label><input type="number" id="arYear" value="${new Date().getFullYear()}" min="2000" max="2100"></div>
      </div>
      <button class="btn btn-primary" id="btnArchiveYear">Archiver cette année et repartir à zéro</button>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Années archivées</h3><span class="hint">Cliquez sur une année pour la consulter</span></div>
      <div id="archivesList"></div>
    </div>
  `;
  const list = document.getElementById("archivesList");
  if(!years.length){
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/></svg>
      <div class="big">Aucune année archivée pour le moment</div>
      <div>Utilisez le bouton ci-dessus en fin d'année pour créer votre première archive.</div>
    </div>`;
  } else {
    list.innerHTML = `<div class="commission-summary-grid">` + years.map(a=>{
      const d = a.data;
      const nbMissions = groupMissionsList(d.missions||[]).length;
      return `
      <div class="commission-summary-card" data-open-archive="${a.id}">
        <div class="csc-icon riz"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/></svg></div>
        <div class="csc-body">
          <div class="csc-title">Année ${a.annee}</div>
          <div class="csc-stats">${nbMissions} mission(s) · ${(d.echantillons||[]).length} échantillon(s) · archivée le ${fmtDate(a.dateArchivage)}</div>
        </div>
        <span class="csc-arrow">→</span>
      </div>`;
    }).join("") + `</div>`;
    list.querySelectorAll("[data-open-archive]").forEach(card=> card.addEventListener("click", ()=> openArchiveDetail(card.dataset.openArchive)));
  }
  document.getElementById("btnArchiveYear").addEventListener("click", archiveCurrentYearAndReset);
}

async function archiveCurrentYearAndReset(){
  const year = parseInt(document.getElementById("arYear").value, 10) || new Date().getFullYear();
  const nbMissions = groupMissionsList(state.missions).length;
  const totalItems = nbMissions + state.echantillons.length + state.activites.length + state.reunionsCodinorm.length;
  if(!totalItems){ toast("Aucune donnée d'activité à archiver pour le moment."); return; }
  const confirmMsg = `Archiver l'année ${year} ? Ceci va :\n\n• Conserver définitivement ${nbMissions} mission(s), ${state.echantillons.length} échantillon(s), ${state.activites.length} réunion(s)/activité(s), ${state.reunionsCodinorm.length} réunion(s) CODINORM, ainsi que les sessions/agréments des commissions et les rappels actuels.\n• Vider ensuite ces modules pour repartir à zéro.\n\nLa base d'entreprises n'est pas affectée. Cette action est irréversible (les données archivées restent consultables, mais ne peuvent plus être modifiées). Continuer ?`;
  if(!await appConfirm(confirmMsg)) return;
  takeSafetySnapshot(`Avant archivage de l'année ${year}`);

  const archivedCommissions = {};
  Object.keys(state.commissions).forEach(key=>{
    archivedCommissions[key] = { nom: state.commissions[key].nom, sessions: deepClone(state.commissions[key].sessions||[]) };
  });
  const archivedDossiers = {};
  Object.keys(state.dossiers).forEach(key=>{
    archivedDossiers[key] = { nom: state.dossiers[key].nom, sessions: deepClone(state.dossiers[key].sessions||[]) };
  });

  const archive = {
    id: uid("arch"),
    annee: year,
    dateArchivage: todayISO(),
    data: {
      missions: deepClone(state.missions),
      echantillons: deepClone(state.echantillons),
      activites: deepClone(state.activites),
      reunionsCodinorm: deepClone(state.reunionsCodinorm),
      rappels: deepClone(state.rappels.filter(r=>!r.auto || r.statut==="Fait")),
      commissions: archivedCommissions,
      dossiers: archivedDossiers,
    },
  };
  state.archives.push(archive);

  // Remise à zéro des modules d'activité de l'année (les données de référence sont conservées).
  state.missions = [];
  state.echantillons = [];
  state.activites = [];
  state.reunionsCodinorm = [];
  // Les rappels générés automatiquement pointent vers des missions/activités/sessions qui
  // viennent d'être archivées : ils sont retirés (l'information reste dans l'archive). Les
  // rappels saisis manuellement, indépendants de tout enregistrement précis, sont conservés.
  state.rappels = state.rappels.filter(r=> !r.auto);
  Object.keys(state.commissions).forEach(key=>{
    state.commissions[key].sessions = [];
  });
  Object.keys(state.dossiers).forEach(key=>{
    state.dossiers[key].sessions = [];
  });

  saveState();
  toast(`Année ${year} archivée avec succès. Les modules d'activité ont été réinitialisés.`);
  renderArchives();
  renderDashboard();
}

function openArchiveDetail(id){
  const a = state.archives.find(x=>x.id===id);
  if(!a) return;
  const d = a.data;
  const groups = groupMissionsList(d.missions||[]);
  const nbEntreprises = groups.reduce((s,g)=> s+groupNbEntreprises(g), 0);
  const nbEchProduits = (d.echantillons||[]).reduce((s,e)=> s+(e.produits||[]).length, 0);

  const missionsRows = groups.slice(0, 100).map(g=>{
    const period = (g.dateFin && g.dateFin!==g.dateDebut) ? `${fmtDate(g.dateDebut)} au ${fmtDate(g.dateFin)}` : fmtDate(g.dateDebut);
    return `<tr><td>${period}</td><td>${escapeHtml(g.objet||"—")}</td><td>${escapeHtml(g.secteur||"—")}</td><td>${groupNbEntreprises(g)}</td><td>${groupNbEchantillons(g)}</td></tr>`;
  }).join("") || `<tr class="empty-row"><td colspan="5">Aucune mission archivée.</td></tr>`;

  const echRows = (d.echantillons||[]).slice(0, 150).map(e=>{
    const produits = (e.produits||[]).map(p=>p.nom).filter(Boolean).join(", ") || "—";
    return `<tr><td>${e.datePrelevement?fmtDate(e.datePrelevement):"—"}</td><td>${escapeHtml(e.entreprise||"—")}</td><td>${escapeHtml(produits)}</td><td>${escapeHtml(e.statut||"—")}</td></tr>`;
  }).join("") || `<tr class="empty-row"><td colspan="4">Aucun échantillon archivé.</td></tr>`;

  const reunionRows = [
    ...(d.activites||[]).map(x=>({ date:x.date, type:x.type||"Réunion", titre:x.titre, lieu:x.lieu })),
    ...(d.reunionsCodinorm||[]).map(x=>({ date:x.date, type:"CODINORM", titre:x.titre, lieu:x.lieu })),
  ].sort((x,y)=> (x.date||"").localeCompare(y.date||"")).slice(0,150)
    .map(x=> `<tr><td>${x.date?fmtDate(x.date):"—"}</td><td>${escapeHtml(x.type)}</td><td>${escapeHtml(x.titre||"—")}</td><td>${escapeHtml(x.lieu||"—")}</td></tr>`)
    .join("") || `<tr class="empty-row"><td colspan="4">Aucune réunion archivée.</td></tr>`;

  const commissionsResume = Object.keys(d.commissions||{}).map(key=>{
    const c = d.commissions[key];
    const nbStruct = c.sessions.reduce((s,x)=> s+(x.structures||[]).length, 0);
    return `<li>${escapeHtml(c.nom)} — ${c.sessions.length} session(s), ${nbStruct} structure(s) demandeuse(s)</li>`;
  }).join("") || "<li>Aucune donnée de commission archivée.</li>";
  const dossiersResume = Object.keys(d.dossiers||{}).map(key=>{
    const c = d.dossiers[key];
    const nbStruct = c.sessions.reduce((s,x)=> s+(x.structures||[]).length, 0);
    return `<li>${escapeHtml(c.nom)} — ${c.sessions.length} session(s), ${nbStruct} élément(s) suivi(s)</li>`;
  }).join("") || "<li>Aucun dossier suivi archivé.</li>";

  // Rassemble tous les fichiers joints présents dans les enregistrements archivés de l'année
  // (les fichiers eux-mêmes restent sur le serveur/Google — seule la référence est archivée ici).
  const fichiers = [];
  const collect = (list, label) => (list||[]).forEach(rec => (rec.pieceJointes||[]).forEach(f => fichiers.push({ ...f, origine: label })));
  collect(d.missions, "Mission");
  collect(d.echantillons, "Échantillon");
  collect(d.activites, "Réunion / activité");
  collect(d.reunionsCodinorm, "CODINORM");
  Object.values(d.commissions||{}).forEach(c=>{
    collect(c.sessions, `Session — ${c.nom}`);
    (c.sessions||[]).forEach(s=> collect(s.structures, `Structure — ${c.nom}`));
  });
  Object.values(d.dossiers||{}).forEach(c=>{
    collect(c.sessions, `Session — ${c.nom}`);
    (c.sessions||[]).forEach(s=> collect(s.structures, `Élément — ${c.nom}`));
  });
  const fichiersRows = fichiers.slice(0, 200).map(f=>`
    <tr>
      <td><strong>${escapeHtml(f.originalName||"fichier")}</strong></td>
      <td>${escapeHtml(f.origine)}</td>
      <td>${formatFileSize(f.size)}</td>
      <td><button class="icon-btn" data-download-archived-file="${f.id}" data-file-name="${escapeHtml(f.originalName||"fichier")}" title="Télécharger">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
      </button></td>
    </tr>`).join("") || `<tr class="empty-row"><td colspan="4">Aucun fichier joint dans les enregistrements de cette année.</td></tr>`;

  const html = drawerShell(
    `Archive — Année ${a.annee}`,
    `
    <p class="text-muted">Archivée le ${fmtDate(a.dateArchivage)}. Ces données sont conservées à titre de référence et ne sont plus modifiables ici.</p>
    <div class="comm-kpi-grid" style="grid-template-columns:repeat(3,1fr); margin-bottom:16px;">
      <div class="kpi"><div class="kpi-label">Missions</div><div class="kpi-value">${groups.length}</div></div>
      <div class="kpi accent"><div class="kpi-label">Entreprises visitées</div><div class="kpi-value">${nbEntreprises}</div></div>
      <div class="kpi"><div class="kpi-label">Produits échantillonnés</div><div class="kpi-value">${nbEchProduits}</div></div>
    </div>

    <div class="comm-tabs">
      <div class="comm-tab active" data-arch-tab="missions">Missions (${groups.length})</div>
      <div class="comm-tab" data-arch-tab="echantillons">Échantillons (${(d.echantillons||[]).length})</div>
      <div class="comm-tab" data-arch-tab="reunions">Réunions</div>
      <div class="comm-tab" data-arch-tab="commissions">Commissions</div>
      <div class="comm-tab" data-arch-tab="fichiers">Fichiers joints (${fichiers.length})</div>
    </div>

    <div class="comm-tabpanel" data-arch-panel="missions">
      <div class="table-wrap no-scroll-limit">
        <table><thead><tr><th>Période</th><th>Objet</th><th>Secteur</th><th>Entreprises</th><th>Échantillons</th></tr></thead><tbody>${missionsRows}</tbody></table>
      </div>
      ${groups.length>100 ? `<p class="text-muted" style="font-size:12px;">Affichage limité aux 100 premières missions — téléchargez l'archive complète (JSON) pour tout consulter.</p>` : ""}
    </div>
    <div class="comm-tabpanel" data-arch-panel="echantillons" hidden>
      <div class="table-wrap no-scroll-limit">
        <table><thead><tr><th>Date</th><th>Entreprise</th><th>Produits</th><th>Statut</th></tr></thead><tbody>${echRows}</tbody></table>
      </div>
    </div>
    <div class="comm-tabpanel" data-arch-panel="reunions" hidden>
      <div class="table-wrap no-scroll-limit">
        <table><thead><tr><th>Date</th><th>Type</th><th>Titre</th><th>Lieu</th></tr></thead><tbody>${reunionRows}</tbody></table>
      </div>
    </div>
    <div class="comm-tabpanel" data-arch-panel="commissions" hidden>
      <div class="form-section-title" style="margin-top:0;">Commissions &amp; comités</div>
      <ul style="font-size:13px; color:var(--ink); padding-left:20px;">${commissionsResume}</ul>
      <div class="form-section-title">Dossiers suivis</div>
      <ul style="font-size:13px; color:var(--ink); padding-left:20px;">${dossiersResume}</ul>
    </div>
    <div class="comm-tabpanel" data-arch-panel="fichiers" hidden>
      <p class="text-muted" style="font-size:12.5px;">Les fichiers restent stockés sur votre serveur ou espace Google ; cette liste permet de les retrouver et de les retélécharger.</p>
      <div class="table-wrap no-scroll-limit">
        <table><thead><tr><th>Fichier</th><th>Origine</th><th>Taille</th><th></th></tr></thead><tbody>${fichiersRows}</tbody></table>
      </div>
      ${fichiers.length>200 ? `<p class="text-muted" style="font-size:12px;">Affichage limité aux 200 premiers fichiers.</p>` : ""}
    </div>
    `,
    `<button class="btn btn-danger" id="btnDeleteArchive">Supprimer cette archive</button><div style="flex:1"></div><button class="btn" id="drawerCancel">Fermer</button><button class="btn btn-primary" id="btnDownloadArchive">Télécharger (JSON)</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    drawer.querySelectorAll("[data-arch-tab]").forEach(tab=>{
      tab.addEventListener("click", ()=>{
        drawer.querySelectorAll("[data-arch-tab]").forEach(t=> t.classList.toggle("active", t===tab));
        drawer.querySelectorAll("[data-arch-panel]").forEach(p=> p.hidden = p.dataset.archPanel !== tab.dataset.archTab);
      });
    });
    drawer.querySelectorAll("[data-download-archived-file]").forEach(btn=>{
      btn.addEventListener("click", ()=> downloadAttachment(btn.dataset.downloadArchivedFile, btn.dataset.fileName));
    });
    document.getElementById("btnDownloadArchive").addEventListener("click", ()=>{
      const blob = new Blob([JSON.stringify(a, null, 2)], { type:"application/json" });
      downloadBlob(`sdcqn_archive_${a.annee}.json`, blob);
    });
    document.getElementById("btnDeleteArchive").addEventListener("click", async ()=>{
      if(!await appConfirm(`⚠️ Supprimer définitivement l'archive de l'année ${a.annee} ? Ces données ne pourront plus être récupérées une fois confirmées, sauf si vous avez téléchargé une copie (JSON). Continuer ?`)) return;
      if(syncCfg.key){
        const saisie = await appPrompt("Pour confirmer cette suppression définitive, saisissez la clé d'accès au serveur de synchronisation :");
        if(saisie === null) return;
        if(saisie !== syncCfg.key){ toast("Clé d'accès incorrecte — suppression annulée."); return; }
      } else {
        const saisie = await appPrompt(`Aucune clé de serveur n'est configurée sur cet appareil. Pour confirmer cette suppression définitive, tapez le mot SUPPRIMER en majuscules :`);
        if(saisie === null) return;
        if(saisie !== "SUPPRIMER"){ toast("Confirmation incorrecte — suppression annulée."); return; }
      }
      state.archives = state.archives.filter(x=>x.id!==a.id);
      saveState();
      closeDrawer();
      renderArchives();
      toast("Archive supprimée.");
    });
  });
}

/* =========================================================================
   COMMISSIONS (Retraitement du Riz / Tabac) — module générique
   ========================================================================= */

const STATUT_AGREMENT_BADGE = { "En instruction":"badge-warn", "Agréé":"badge-success", "Rejeté":"badge-danger" };

function commData(key){ return state.commissions[key]; }
let commAgrementsSortState = { key:null, dir:1 };

/* ---------------------------- Liste des commissions & comités (extensible) ---------------------------- */

function renderCommissionsList(){
  const el = document.getElementById("view-commissions");
  const keys = Object.keys(state.commissions).sort((a,b)=> commissionMeta(a).name.localeCompare(commissionMeta(b).name));

  el.innerHTML = `
    <div class="toolbar">
      <div style="flex:1"></div>
      <button class="btn btn-primary" id="btnNewCommission">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
        Nouvelle commission / comité
      </button>
    </div>
    <div id="commissionsListBody"></div>
  `;

  const body = document.getElementById("commissionsListBody");
  if(!keys.length){
    body.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      <div class="big">Aucune commission ou comité enregistré</div>
      <div>Utilisez « Nouvelle commission / comité » pour en créer une.</div>
    </div>`;
  } else {
    body.innerHTML = `<div class="commission-summary-grid">` + keys.map(k=>{
      const d = commData(k);
      const nbStruct = d.sessions.reduce((s,x)=> s+(x.structures||[]).length, 0);
      return `
      <div class="commission-summary-card" data-open-commission="${k}">
        <div class="csc-icon riz">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <div class="csc-body">
          <div class="csc-title">${escapeHtml(d.nom)}</div>
          <div class="csc-stats">${d.sessions.length} session(s) · ${nbStruct} structure(s) demandeuse(s)</div>
        </div>
        <span class="csc-arrow">→</span>
      </div>`;
    }).join("") + `</div>`;
    body.querySelectorAll("[data-open-commission]").forEach(card=>{
      card.addEventListener("click", ()=> openCommissionDetail(card.dataset.openCommission));
    });
  }

  document.getElementById("btnNewCommission").addEventListener("click", openNewCommissionForm);
}

function openNewCommissionForm(){
  const html = drawerShell(
    "Nouvelle commission / comité",
    `
    <div class="field"><label>Nom de la commission ou du comité</label><input type="text" id="nc_nom" placeholder="Ex : Comité de suivi des emballages"></div>
    <p class="text-muted" style="font-size:12px;">Une fois créée, cette commission dispose de son propre espace pour enregistrer ses sessions/réunions et ses structures demandeuses d'agrément, exactement comme les commissions Retraitement Riz et Tabac.</p>
    `,
    `<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveNewCommission">Créer</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnSaveNewCommission").addEventListener("click", ()=>{
      const nom = document.getElementById("nc_nom").value.trim();
      if(!nom){ toast("Veuillez indiquer un nom."); return; }
      const key = uid("comm");
      state.commissions[key] = { nom, sessions:[], membres:[], actions:[], agrements:[] };
      saveState();
      closeDrawer();
      toast("Commission créée.");
      openCommissionDetail(key);
    });
  });
}

function renderCommissionShell(key){
  const el = document.getElementById("view-commission-detail");
  el.innerHTML = `
    <div class="comm-breadcrumb">
      <a href="#" id="commBackToList">← Commissions &amp; Comités</a>
      <div style="flex:1"></div>
      <button class="btn btn-sm" id="btnRenameCommission">Renommer</button>
      <button class="btn btn-sm btn-danger" id="btnDeleteCommission">Supprimer cette commission</button>
    </div>
    <p class="text-muted">Chaque session tenue peut avoir ses propres structures demandeuses d'agrément, et chaque structure ses propres missions d'inspection — cliquez sur une session pour y accéder.</p>
    <div class="toolbar">
      <div style="flex:1"></div>
      <button class="btn btn-primary" id="btnNewCommSession">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
        Nouvelle session
      </button>
    </div>
    <div id="comm-${key}-sessions"></div>
  `;

  document.getElementById("btnNewCommSession").addEventListener("click", ()=> openCommSessionForm(key, null));
  document.getElementById("commBackToList").addEventListener("click", (e)=>{ e.preventDefault(); goView("commissions"); });
  document.getElementById("btnRenameCommission").addEventListener("click", async ()=>{
    const current = state.commissions[key].nom;
    const nouveauNom = await appPrompt("Nouveau nom de cette commission / ce comité :", current);
    if(nouveauNom === null) return;
    const trimmed = nouveauNom.trim();
    if(!trimmed){ toast("Le nom ne peut pas être vide."); return; }
    state.commissions[key].nom = trimmed;
    saveState();
    renderCommissionShell(key);
    renderCommission(key);
    toast("Commission renommée.");
  });
  document.getElementById("btnDeleteCommission").addEventListener("click", async ()=>{
    if(!await appConfirm(`Supprimer définitivement « ${state.commissions[key].nom} » et toutes ses sessions/structures enregistrées ? Cette action est irréversible.`)) return;
    (state.commissions[key].sessions||[]).forEach(s => removeAutoRappel("commSession", s.id));
    delete state.commissions[key];
    saveState();
    goView("commissions");
    toast("Commission supprimée.");
  });
}

function renderCommission(key){
  if(!document.getElementById("comm-"+key+"-sessions")) renderCommissionShell(key);
  const d = commData(key);

  // ---- Sessions list ----
  const sessBox = document.getElementById(`comm-${key}-sessions`);
  const sessions = d.sessions.slice().sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  if(!sessions.length){
    sessBox.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/></svg>
      <div class="big">Aucune session enregistrée</div>
      <div>Ajoutez la première session de la ${escapeHtml(commissionMeta(key).name)}.</div>
    </div>`;
  } else {
    sessBox.innerHTML = `<div class="panel" style="padding:8px 20px;">` + sessions.map(s=>{
      const ds = fmtDateShort(s.date);
      const nbStruct = (s.structures||[]).length;
      return `
      <div class="activity-item" data-open-session="${s.id}" style="cursor:pointer;">
        <div class="activity-date"><div class="d">${ds.d}</div><div class="m">${ds.m}</div></div>
        <div class="activity-body">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <div class="title">${escapeHtml(s.titre)}</div>
              <div class="meta">${escapeHtml(s.lieu||"Lieu non précisé")}${s.participants ? " · "+escapeHtml(s.participants) : ""}</div>
            </div>
            <div class="row-actions">
              <button class="icon-btn" data-edit-session="${s.id}" title="Modifier">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              </button>
            </div>
          </div>
          ${s.ordreDuJour ? `<div class="notes"><strong>Ordre du jour :</strong> ${escapeHtml(s.ordreDuJour)}</div>` : ""}
          ${s.decisions ? `<div class="notes"><strong>Décisions / points retenus :</strong> ${escapeHtml(s.decisions)}</div>` : ""}
          <div style="margin-top:6px;"><span class="badge badge-neutral"><span class="badge-dot"></span>${nbStruct} structure${nbStruct>1?"s":""} demandeuse${nbStruct>1?"s":""}</span></div>
        </div>
      </div>`;
    }).join("") + `</div>`;
    sessBox.querySelectorAll("[data-open-session]").forEach(card=>{
      card.addEventListener("click", (ev)=>{
        if(ev.target.closest("[data-edit-session]")) return;
        openCommSessionFiche(key, card.dataset.openSession);
      });
    });
    sessBox.querySelectorAll("[data-edit-session]").forEach(btn=> btn.addEventListener("click", (ev)=>{ ev.stopPropagation(); openCommSessionForm(key, btn.dataset.editSession); }));
  }
}

function openCommSessionFiche(key, id){
  const d = commData(key);
  const s = d.sessions.find(x=>x.id===id);
  if(!s) return;
  if(!s.structures) s.structures = [];
  let structures = s.structures.slice().sort((a,b)=> (b.dateDemande||"").localeCompare(a.dateDemande||""));
  if(commAgrementsSortState.key){
    const sk = commAgrementsSortState.key, dir = commAgrementsSortState.dir;
    structures = structures.slice().sort((a,b)=> sortCompare(a[sk], b[sk], dir));
  }
  const structRows = structures.map(a=>`
    <tr data-open-agrement="${a.id}" style="cursor:pointer;">
      <td><strong>${escapeHtml(a.structure)}</strong></td>
      <td>${a.dateDemande ? fmtDate(a.dateDemande) : "—"}</td>
      <td>${escapeHtml(a.contact||"—")}</td>
      <td><span class="badge ${STATUT_AGREMENT_BADGE[a.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(a.statut||"—")}</span></td>
      <td><div class="row-actions">
        <button class="icon-btn" data-edit-agrement="${a.id}" title="Modifier">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
      </div></td>
    </tr>`).join("") || `<tr class="empty-row"><td colspan="5">Aucune structure demandeuse enregistrée pour cette session.</td></tr>`;

  const html = drawerShell(
    `Fiche session — ${escapeHtml(commissionMeta(key).name)}`,
    `
    <div class="field-grid">
      ${roField("Date", fmtDate(s.date))}
      ${roField("Lieu", escapeHtml(s.lieu||"—"))}
      ${roField("Participants", escapeHtml(s.participants||"—"))}
    </div>
    <div class="form-section-title">Titre / objet</div>
    <p>${escapeHtml(s.titre)}</p>
    ${s.ordreDuJour ? `<div class="form-section-title">Ordre du jour</div><p style="white-space:pre-wrap;">${escapeHtml(s.ordreDuJour)}</p>` : ""}
    ${s.decisions ? `<div class="form-section-title">Décisions / points retenus</div><p style="white-space:pre-wrap;">${escapeHtml(s.decisions)}</p>` : ""}

    <div class="form-section-title" style="margin-top:24px;">Structures demandeuses de cette session</div>
    <p class="text-muted" style="font-size:12px; margin-top:-6px;">Chaque structure peut ensuite avoir ses propres missions d'inspection.</p>
    <div class="toolbar">
      <div style="flex:1"></div>
      <button class="btn btn-sm btn-primary" id="btnNewStructForSession" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
        Ajouter une structure demandeuse
      </button>
    </div>
    <div class="table-wrap">
      <table id="comm-sess-${id}-structures-table">
        <thead><tr><th data-sort-key="structure">Structure</th><th data-sort-key="dateDemande">Date de la demande</th><th data-sort-key="contact">Contact</th><th data-sort-key="statut">Statut</th><th></th></tr></thead>
        <tbody>${structRows}</tbody>
      </table>
    </div>
    `,
    `<button class="btn btn-danger" id="btnDeleteSession">Supprimer la session</button><div style="flex:1"></div><button class="btn" id="drawerCancel">Fermer</button><button class="btn btn-primary" id="btnFicheEdit">Modifier la session</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openCommSessionForm(key, s.id));
    document.getElementById("btnDeleteSession").addEventListener("click", async ()=>{
      if(!await appConfirm("Supprimer cette session et toutes ses structures demandeuses enregistrées ?")) return;
      removeAutoRappel("commSession", s.id);
      d.sessions = d.sessions.filter(x=>x.id!==s.id);
      saveState(); closeDrawer(); renderCommission(key);
      toast("Session supprimée.");
    });
    document.getElementById("btnNewStructForSession").addEventListener("click", ()=> openCommAgrementForm(key, s.id, null));
    attachSortableHeaders(`comm-sess-${id}-structures-table`, commAgrementsSortState, ()=> openCommSessionFiche(key, id));
    document.querySelectorAll("[data-open-agrement]").forEach(row=>{
      row.addEventListener("click", (ev)=>{
        if(ev.target.closest("[data-edit-agrement]")) return;
        openCommAgrementFiche(key, s.id, row.dataset.openAgrement);
      });
    });
    document.querySelectorAll("[data-edit-agrement]").forEach(btn=> btn.addEventListener("click", (ev)=>{ ev.stopPropagation(); openCommAgrementForm(key, s.id, btn.dataset.editAgrement); }));
  });
}

function openCommAgrementFiche(key, sessionId, id){
  const d = commData(key);
  const s = d.sessions.find(x=>x.id===sessionId);
  if(!s) return;
  if(!s.structures) s.structures = [];
  const a = s.structures.find(x=>x.id===id);
  if(!a) return;
  if(!a.missionsLiees) a.missionsLiees = [];
  const missionsLiees = a.missionsLiees.map(mid=> state.missions.find(x=>x.id===mid)).filter(Boolean)
    .sort((x,y)=> (y.dateVisite||y.dateDebut||"").localeCompare(x.dateVisite||x.dateDebut||""));
  const missionsRows = missionsLiees.map(m=>`
    <div class="activity-item" data-open-linked-mission="${m.id}" style="cursor:pointer;">
      <div class="activity-body">
        <div class="title">${escapeHtml(m.objet||"Mission")}</div>
        <div class="meta">${fmtDate(m.dateVisite||m.dateDebut)} · ${escapeHtml(m.statut||"—")}</div>
      </div>
    </div>`).join("") || `<p class="text-muted" style="font-size:12.5px;">Aucune mission enregistrée pour cette structure.</p>`;

  const html = drawerShell(
    `Fiche structure — ${escapeHtml(a.structure)}`,
    `
    <p class="text-muted" style="font-size:12px;">Structure demandeuse rattachée à la session « ${escapeHtml(s.titre)} » du ${fmtDate(s.date)}.</p>
    <div class="field-grid">
      ${roField("Structure", escapeHtml(a.structure))}
      ${roField("Date de la demande", a.dateDemande?fmtDate(a.dateDemande):"—")}
      ${roField("Contact", escapeHtml(a.contact||"—"))}
      ${roField("Statut", `<span class="badge ${STATUT_AGREMENT_BADGE[a.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(a.statut||"—")}</span>`)}
    </div>
    ${a.observations ? `<div class="form-section-title">Observations</div><p style="white-space:pre-wrap;">${escapeHtml(a.observations)}</p>` : ""}
    <div class="form-section-title" style="display:flex; align-items:center; justify-content:space-between; border-top:none; margin-top:24px; padding-top:0;">
      <span>Missions effectuées auprès de cette structure</span>
    </div>
    <p class="text-muted" style="font-size:12px; margin-top:-6px;">Ces missions sont enregistrées dans le module « Missions de contrôle » et apparaissent donc aussi sur le tableau de bord et dans les rapports.</p>
    <button class="btn btn-sm" id="btnNewLinkedMission" type="button" style="margin-bottom:10px;">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
      Enregistrer une mission pour cette structure
    </button>
    <div id="linkedMissionsList">${missionsRows}</div>
    `,
    ficheFoot()
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openCommAgrementForm(key, sessionId, a.id));
    document.getElementById("btnNewLinkedMission").addEventListener("click", ()=>{
      closeDrawer();
      const prefill = { entreprise: a.structure, objet: `Mission — ${commissionMeta(key).name}` };
      openMissionForm(null, prefill, (record)=>{
        a.missionsLiees = a.missionsLiees || [];
        a.missionsLiees.push(record.id);
        saveState();
        toast("Mission liée à la structure demandeuse.");
        openCommAgrementFiche(key, sessionId, a.id);
      });
    });
    document.querySelectorAll("[data-open-linked-mission]").forEach(row=>{
      row.addEventListener("click", ()=>{
        closeDrawer();
        goView("missions");
        openMissionFiche(row.dataset.openLinkedMission);
      });
    });
  });
}

function openCommSessionForm(key, id){
  const d = commData(key);
  const s = id ? d.sessions.find(x=>x.id===id) : null;
  const html = drawerShell(
    (s?"Modifier la session — ":"Nouvelle session — ") + commissionMeta(key).name,
    `
    <div class="field-grid">
      <div class="field"><label>Date</label><input type="date" id="cf_date" value="${s?.date||todayISO()}"></div>
      <div class="field"><label>Lieu</label><input type="text" id="cf_lieu" value="${escapeHtml(s?.lieu||"")}" placeholder="Ex : Salle de conférence MCIA"></div>
    </div>
    <div class="field"><label>Titre / objet de la session</label><input type="text" id="cf_titre" value="${escapeHtml(s?.titre||"")}" placeholder="Ex : Session ordinaire n°2"></div>
    ${multiSelectParticipantsHtml("cf_participants", s?.participants)}
    <div class="field"><label>Ordre du jour</label><textarea id="cf_odj" rows="3" spellcheck="true">${escapeHtml(s?.ordreDuJour||"")}</textarea></div>
    <div class="field"><label>Décisions / points retenus</label><textarea id="cf_decisions" rows="4" spellcheck="true">${escapeHtml(s?.decisions||"")}</textarea></div>

    ${attachmentsSectionHtml(s)}
    `,
    `${s?`<button class="btn btn-danger" id="btnDeleteComm">Supprimer</button>`:""}<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveComm">${s?"Enregistrer":"Créer la session"}</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(s);
    document.getElementById("btnSaveComm").addEventListener("click", ()=>{
      const titre = document.getElementById("cf_titre").value.trim();
      if(!titre){ toast("Veuillez indiquer un titre."); return; }
      const data = {
        date: document.getElementById("cf_date").value || todayISO(),
        lieu: document.getElementById("cf_lieu").value.trim(),
        titre,
        participants: collectParticipants("cf_participants"),
        ordreDuJour: document.getElementById("cf_odj").value.trim(),
        decisions: document.getElementById("cf_decisions").value.trim(),
      };
      let rec = s;
      if(s){ Object.assign(s, data); toast("Session mise à jour."); }
      else { rec = { id: uid("sess"), ...data, structures:[], pieceJointes: consumePendingAttachments() }; d.sessions.push(rec); toast("Session enregistrée."); }
      syncAutoRappel("commSession", rec.id, { date: rec.date, titre: `${rec.titre} — ${commissionMeta(key).name}`, lieu: rec.lieu, type: commissionMeta(key).name });
      saveState(); closeDrawer(); renderCommission(key); renderDashboard();
    });
    document.getElementById("btnDeleteComm")?.addEventListener("click", async ()=>{
      if(!await appConfirm("Supprimer cette session ?")) return;
      removeAutoRappel("commSession", s.id);
      d.sessions = d.sessions.filter(x=>x.id!==s.id);
      saveState(); closeDrawer(); renderCommission(key); renderDashboard();
      toast("Session supprimée.");
    });
  });
}

function openCommAgrementForm(key, sessionId, id){
  const d = commData(key);
  const s = d.sessions.find(x=>x.id===sessionId);
  if(!s) return;
  if(!s.structures) s.structures = [];
  const a = id ? s.structures.find(x=>x.id===id) : null;
  const label = commissionMeta(key);
  const html = drawerShell(
    (a?"Modifier la structure — ":"Nouvelle structure demandeuse — ") + label.agrementTab,
    `
    <div class="field"><label>Nom de la structure</label><input type="text" id="cf_structure" value="${escapeHtml(a?.structure||"")}" placeholder="Raison sociale de la structure"></div>
    <div class="field-grid">
      <div class="field"><label>Date de la demande</label><input type="date" id="cf_datedemande" value="${a?.dateDemande||todayISO()}"></div>
      <div class="field"><label>Contact</label><input type="text" id="cf_contact" value="${escapeHtml(a?.contact||"")}" placeholder="Téléphone ou e-mail"></div>
    </div>
    <div class="field"><label>Statut de la demande</label>
      <select id="cf_statut">${["En instruction","Agréé","Rejeté"].map(s=>`<option ${(a?.statut||"En instruction")===s?"selected":""}>${s}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Observations</label><textarea id="cf_observations" rows="3" placeholder="Précisions sur le dossier…" spellcheck="true">${escapeHtml(a?.observations||"")}</textarea></div>

    ${attachmentsSectionHtml(a)}
    `,
    `${a?`<button class="btn btn-danger" id="btnDeleteComm">Supprimer</button>`:""}<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveComm">${a?"Enregistrer":"Ajouter"}</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(a);
    document.getElementById("btnSaveComm").addEventListener("click", ()=>{
      const structure = document.getElementById("cf_structure").value.trim();
      if(!structure){ toast("Veuillez indiquer le nom de la structure."); return; }
      const data = {
        structure,
        dateDemande: document.getElementById("cf_datedemande").value || todayISO(),
        contact: document.getElementById("cf_contact").value.trim(),
        statut: document.getElementById("cf_statut").value,
        observations: document.getElementById("cf_observations").value.trim(),
      };
      if(a){ Object.assign(a, data); toast("Structure mise à jour."); }
      else { const rec = { id: uid("agr"), ...data, missionsLiees:[], pieceJointes: consumePendingAttachments() }; s.structures.push(rec); toast("Structure enregistrée."); }
      saveState(); closeDrawer(); openCommSessionFiche(key, sessionId);
    });
    document.getElementById("btnDeleteComm")?.addEventListener("click", async ()=>{
      if(!await appConfirm("Retirer cette structure ?")) return;
      s.structures = s.structures.filter(x=>x.id!==a.id);
      saveState(); closeDrawer(); openCommSessionFiche(key, sessionId);
      toast("Structure retirée.");
    });
  });
}

/* =========================================================================
   DOSSIERS SUIVIS — module générique, structuré exactement comme les
   Commissions & Comités (chacun avec ses propres sessions/réunions et ses
   éléments suivis), pour tout autre type de dossier à suivre dans la durée.
   ========================================================================= */

function dossierData(key){ return state.dossiers[key]; }
function dossierMeta(key){
  const nom = (state.dossiers[key] && state.dossiers[key].nom) || "Dossier suivi";
  return { name: nom, agrementTab: "Éléments suivis", agrementFull: "cet élément", agrementBtn: "Ajouter un élément" };
}
let dosElementsSortState = { key:null, dir:1 };

function renderDossiersList(){
  const el = document.getElementById("view-dossiers");
  const keys = Object.keys(state.dossiers).sort((a,b)=> dossierMeta(a).name.localeCompare(dossierMeta(b).name));

  el.innerHTML = `
    <p class="text-muted">Suivez ici tout dossier ne relevant pas d'une commission ou d'un comité (un chantier, une procédure, un suivi ponctuel...), avec la même organisation : sessions/réunions et éléments suivis.</p>
    <div class="toolbar">
      <div style="flex:1"></div>
      <button class="btn btn-primary" id="btnNewDossier">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
        Nouveau dossier suivi
      </button>
    </div>
    <div id="dossiersListBody"></div>
  `;

  const body = document.getElementById("dossiersListBody");
  if(!keys.length){
    body.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
      <div class="big">Aucun dossier suivi enregistré</div>
      <div>Utilisez « Nouveau dossier suivi » pour en créer un.</div>
    </div>`;
  } else {
    body.innerHTML = `<div class="commission-summary-grid">` + keys.map(k=>{
      const d = dossierData(k);
      const nbStruct = d.sessions.reduce((s,x)=> s+(x.structures||[]).length, 0);
      return `
      <div class="commission-summary-card" data-open-dossier="${k}">
        <div class="csc-icon tabac">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
        </div>
        <div class="csc-body">
          <div class="csc-title">${escapeHtml(d.nom)}</div>
          <div class="csc-stats">${d.sessions.length} session(s) · ${nbStruct} élément(s) suivi(s)</div>
        </div>
        <span class="csc-arrow">→</span>
      </div>`;
    }).join("") + `</div>`;
    body.querySelectorAll("[data-open-dossier]").forEach(card=>{
      card.addEventListener("click", ()=> openDossierDetail(card.dataset.openDossier));
    });
  }

  document.getElementById("btnNewDossier").addEventListener("click", openNewDossierForm);
}

function openNewDossierForm(){
  const html = drawerShell(
    "Nouveau dossier suivi",
    `
    <div class="field"><label>Nom du dossier</label><input type="text" id="nd_nom" placeholder="Ex : Suivi de la procédure X"></div>
    <p class="text-muted" style="font-size:12px;">Une fois créé, ce dossier dispose de son propre espace pour enregistrer ses sessions/réunions et ses éléments suivis, exactement comme une commission ou un comité.</p>
    `,
    `<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveNewDossier">Créer</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnSaveNewDossier").addEventListener("click", ()=>{
      const nom = document.getElementById("nd_nom").value.trim();
      if(!nom){ toast("Veuillez indiquer un nom."); return; }
      const key = uid("dos");
      state.dossiers[key] = { nom, sessions:[], membres:[], actions:[], agrements:[] };
      saveState();
      closeDrawer();
      toast("Dossier créé.");
      openDossierDetail(key);
    });
  });
}

function renderDossierShell(key){
  const el = document.getElementById("view-dossier-detail");
  el.innerHTML = `
    <div class="comm-breadcrumb">
      <a href="#" id="dosBackToList">← Dossiers suivis</a>
      <div style="flex:1"></div>
      <button class="btn btn-sm" id="btnRenameDossier">Renommer</button>
      <button class="btn btn-sm btn-danger" id="btnDeleteDossier">Supprimer ce dossier</button>
    </div>
    <p class="text-muted">Chaque session tenue peut avoir ses propres éléments suivis, et chaque élément ses propres missions d'inspection — cliquez sur une session pour y accéder.</p>
    <div class="toolbar">
      <div style="flex:1"></div>
      <button class="btn btn-primary" id="btnNewDosSession">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
        Nouvelle session
      </button>
    </div>
    <div id="dos-${key}-sessions"></div>
  `;

  document.getElementById("btnNewDosSession").addEventListener("click", ()=> openDossierSessionForm(key, null));
  document.getElementById("dosBackToList").addEventListener("click", (e)=>{ e.preventDefault(); goView("dossiers"); });
  document.getElementById("btnRenameDossier").addEventListener("click", async ()=>{
    const current = state.dossiers[key].nom;
    const nouveauNom = await appPrompt("Nouveau nom de ce dossier suivi :", current);
    if(nouveauNom === null) return;
    const trimmed = nouveauNom.trim();
    if(!trimmed){ toast("Le nom ne peut pas être vide."); return; }
    state.dossiers[key].nom = trimmed;
    saveState();
    renderDossierShell(key);
    renderDossier(key);
    toast("Dossier renommé.");
  });
  document.getElementById("btnDeleteDossier").addEventListener("click", async ()=>{
    if(!await appConfirm(`Supprimer définitivement « ${state.dossiers[key].nom} » et toutes ses sessions/éléments enregistrés ? Cette action est irréversible.`)) return;
    (state.dossiers[key].sessions||[]).forEach(s => removeAutoRappel("dosSession", s.id));
    delete state.dossiers[key];
    saveState();
    goView("dossiers");
    toast("Dossier supprimé.");
  });
}

function renderDossier(key){
  if(!document.getElementById("dos-"+key+"-sessions")) renderDossierShell(key);
  const d = dossierData(key);

  // ---- Sessions list ----
  const sessBox = document.getElementById(`dos-${key}-sessions`);
  const sessions = d.sessions.slice().sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  if(!sessions.length){
    sessBox.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/></svg>
      <div class="big">Aucune session enregistrée</div>
      <div>Ajoutez la première session de ce dossier.</div>
    </div>`;
  } else {
    sessBox.innerHTML = `<div class="panel" style="padding:8px 20px;">` + sessions.map(s=>{
      const ds = fmtDateShort(s.date);
      const nbStruct = (s.structures||[]).length;
      return `
      <div class="activity-item" data-open-session="${s.id}" style="cursor:pointer;">
        <div class="activity-date"><div class="d">${ds.d}</div><div class="m">${ds.m}</div></div>
        <div class="activity-body">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <div class="title">${escapeHtml(s.titre)}</div>
              <div class="meta">${escapeHtml(s.lieu||"Lieu non précisé")}${s.participants ? " · "+escapeHtml(s.participants) : ""}</div>
            </div>
            <div class="row-actions">
              <button class="icon-btn" data-edit-session="${s.id}" title="Modifier">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              </button>
            </div>
          </div>
          ${s.ordreDuJour ? `<div class="notes"><strong>Ordre du jour :</strong> ${escapeHtml(s.ordreDuJour)}</div>` : ""}
          ${s.decisions ? `<div class="notes"><strong>Décisions / points retenus :</strong> ${escapeHtml(s.decisions)}</div>` : ""}
          <div style="margin-top:6px;"><span class="badge badge-neutral"><span class="badge-dot"></span>${nbStruct} élément${nbStruct>1?"s":""} suivi${nbStruct>1?"s":""}</span></div>
        </div>
      </div>`;
    }).join("") + `</div>`;
    sessBox.querySelectorAll("[data-open-session]").forEach(card=>{
      card.addEventListener("click", (ev)=>{
        if(ev.target.closest("[data-edit-session]")) return;
        openDossierSessionFiche(key, card.dataset.openSession);
      });
    });
    sessBox.querySelectorAll("[data-edit-session]").forEach(btn=> btn.addEventListener("click", (ev)=>{ ev.stopPropagation(); openDossierSessionForm(key, btn.dataset.editSession); }));
  }
}

function openDossierSessionFiche(key, id){
  const d = dossierData(key);
  const s = d.sessions.find(x=>x.id===id);
  if(!s) return;
  if(!s.structures) s.structures = [];
  let structures = s.structures.slice().sort((a,b)=> (b.dateDemande||"").localeCompare(a.dateDemande||""));
  if(dosElementsSortState.key){
    const sk = dosElementsSortState.key, dir = dosElementsSortState.dir;
    structures = structures.slice().sort((a,b)=> sortCompare(a[sk], b[sk], dir));
  }
  const label = dossierMeta(key);
  const structRows = structures.map(a=>`
    <tr data-open-agrement="${a.id}" style="cursor:pointer;">
      <td><strong>${escapeHtml(a.structure)}</strong></td>
      <td>${a.dateDemande ? fmtDate(a.dateDemande) : "—"}</td>
      <td>${escapeHtml(a.contact||"—")}</td>
      <td><span class="badge ${STATUT_AGREMENT_BADGE[a.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(a.statut||"—")}</span></td>
      <td><div class="row-actions">
        <button class="icon-btn" data-edit-agrement="${a.id}" title="Modifier">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
      </div></td>
    </tr>`).join("") || `<tr class="empty-row"><td colspan="5">Aucun élément suivi enregistré pour cette session.</td></tr>`;

  const html = drawerShell(
    `Fiche session — ${escapeHtml(dossierMeta(key).name)}`,
    `
    <div class="field-grid">
      ${roField("Date", fmtDate(s.date))}
      ${roField("Lieu", escapeHtml(s.lieu||"—"))}
      ${roField("Participants", escapeHtml(s.participants||"—"))}
    </div>
    <div class="form-section-title">Titre / objet</div>
    <p>${escapeHtml(s.titre)}</p>
    ${s.ordreDuJour ? `<div class="form-section-title">Ordre du jour</div><p style="white-space:pre-wrap;">${escapeHtml(s.ordreDuJour)}</p>` : ""}
    ${s.decisions ? `<div class="form-section-title">Décisions / points retenus</div><p style="white-space:pre-wrap;">${escapeHtml(s.decisions)}</p>` : ""}

    <div class="form-section-title" style="margin-top:24px;">${escapeHtml(label.agrementTab)} de cette session</div>
    <p class="text-muted" style="font-size:12px; margin-top:-6px;">Chaque élément peut ensuite avoir ses propres missions d'inspection.</p>
    <div class="toolbar">
      <div style="flex:1"></div>
      <button class="btn btn-sm btn-primary" id="btnNewStructForSession" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
        ${escapeHtml(label.agrementBtn)}
      </button>
    </div>
    <div class="table-wrap">
      <table id="dos-sess-${id}-structures-table">
        <thead><tr><th data-sort-key="structure">Élément</th><th data-sort-key="dateDemande">Date</th><th data-sort-key="contact">Contact</th><th data-sort-key="statut">Statut</th><th></th></tr></thead>
        <tbody>${structRows}</tbody>
      </table>
    </div>
    `,
    `<button class="btn btn-danger" id="btnDeleteSession">Supprimer la session</button><div style="flex:1"></div><button class="btn" id="drawerCancel">Fermer</button><button class="btn btn-primary" id="btnFicheEdit">Modifier la session</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openDossierSessionForm(key, s.id));
    document.getElementById("btnDeleteSession").addEventListener("click", async ()=>{
      if(!await appConfirm("Supprimer cette session et tous ses éléments suivis enregistrés ?")) return;
      removeAutoRappel("dosSession", s.id);
      d.sessions = d.sessions.filter(x=>x.id!==s.id);
      saveState(); closeDrawer(); renderDossier(key);
      toast("Session supprimée.");
    });
    document.getElementById("btnNewStructForSession").addEventListener("click", ()=> openDossierElementForm(key, s.id, null));
    attachSortableHeaders(`dos-sess-${id}-structures-table`, dosElementsSortState, ()=> openDossierSessionFiche(key, id));
    document.querySelectorAll("[data-open-agrement]").forEach(row=>{
      row.addEventListener("click", (ev)=>{
        if(ev.target.closest("[data-edit-agrement]")) return;
        openDossierElementFiche(key, s.id, row.dataset.openAgrement);
      });
    });
    document.querySelectorAll("[data-edit-agrement]").forEach(btn=> btn.addEventListener("click", (ev)=>{ ev.stopPropagation(); openDossierElementForm(key, s.id, btn.dataset.editAgrement); }));
  });
}

function openDossierElementFiche(key, sessionId, id){
  const d = dossierData(key);
  const s = d.sessions.find(x=>x.id===sessionId);
  if(!s) return;
  if(!s.structures) s.structures = [];
  const a = s.structures.find(x=>x.id===id);
  if(!a) return;
  if(!a.missionsLiees) a.missionsLiees = [];
  const missionsLiees = a.missionsLiees.map(mid=> state.missions.find(x=>x.id===mid)).filter(Boolean)
    .sort((x,y)=> (y.dateVisite||y.dateDebut||"").localeCompare(x.dateVisite||x.dateDebut||""));
  const missionsRows = missionsLiees.map(m=>`
    <div class="activity-item" data-open-linked-mission="${m.id}" style="cursor:pointer;">
      <div class="activity-body">
        <div class="title">${escapeHtml(m.objet||"Mission")}</div>
        <div class="meta">${fmtDate(m.dateVisite||m.dateDebut)} · ${escapeHtml(m.statut||"—")}</div>
      </div>
    </div>`).join("") || `<p class="text-muted" style="font-size:12.5px;">Aucune mission enregistrée pour cet élément.</p>`;

  const html = drawerShell(
    `Fiche élément — ${escapeHtml(a.structure)}`,
    `
    <p class="text-muted" style="font-size:12px;">Élément rattaché à la session « ${escapeHtml(s.titre)} » du ${fmtDate(s.date)}.</p>
    <div class="field-grid">
      ${roField("Élément", escapeHtml(a.structure))}
      ${roField("Date", a.dateDemande?fmtDate(a.dateDemande):"—")}
      ${roField("Contact", escapeHtml(a.contact||"—"))}
      ${roField("Statut", `<span class="badge ${STATUT_AGREMENT_BADGE[a.statut]||"badge-neutral"}"><span class="badge-dot"></span>${escapeHtml(a.statut||"—")}</span>`)}
    </div>
    ${a.observations ? `<div class="form-section-title">Observations</div><p style="white-space:pre-wrap;">${escapeHtml(a.observations)}</p>` : ""}
    <div class="form-section-title" style="margin-top:24px;">Missions effectuées auprès de cet élément</div>
    <p class="text-muted" style="font-size:12px; margin-top:-6px;">Ces missions sont enregistrées dans le module « Missions de contrôle » et apparaissent donc aussi sur le tableau de bord et dans les rapports.</p>
    <button class="btn btn-sm" id="btnNewLinkedMission" type="button" style="margin-bottom:10px;">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
      Enregistrer une mission pour cet élément
    </button>
    <div id="linkedMissionsList">${missionsRows}</div>
    `,
    ficheFoot()
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("btnFicheEdit").addEventListener("click", ()=> openDossierElementForm(key, sessionId, a.id));
    document.getElementById("btnNewLinkedMission").addEventListener("click", ()=>{
      closeDrawer();
      const prefill = { entreprise: a.structure, objet: `Mission — ${dossierMeta(key).name}` };
      openMissionForm(null, prefill, (record)=>{
        a.missionsLiees = a.missionsLiees || [];
        a.missionsLiees.push(record.id);
        saveState();
        toast("Mission liée à cet élément.");
        openDossierElementFiche(key, sessionId, a.id);
      });
    });
    document.querySelectorAll("[data-open-linked-mission]").forEach(row=>{
      row.addEventListener("click", ()=>{
        closeDrawer();
        goView("missions");
        openMissionFiche(row.dataset.openLinkedMission);
      });
    });
  });
}

function openDossierSessionForm(key, id){
  const d = dossierData(key);
  const s = id ? d.sessions.find(x=>x.id===id) : null;
  const html = drawerShell(
    (s?"Modifier la session — ":"Nouvelle session — ") + dossierMeta(key).name,
    `
    <div class="field-grid">
      <div class="field"><label>Date</label><input type="date" id="cf_date" value="${s?.date||todayISO()}"></div>
      <div class="field"><label>Lieu</label><input type="text" id="cf_lieu" value="${escapeHtml(s?.lieu||"")}" placeholder="Ex : Salle de conférence MCIA"></div>
    </div>
    <div class="field"><label>Titre / objet de la session</label><input type="text" id="cf_titre" value="${escapeHtml(s?.titre||"")}" placeholder="Ex : Point d'étape n°2"></div>
    ${multiSelectParticipantsHtml("cf_participants", s?.participants)}
    <div class="field"><label>Ordre du jour</label><textarea id="cf_odj" rows="3" spellcheck="true">${escapeHtml(s?.ordreDuJour||"")}</textarea></div>
    <div class="field"><label>Décisions / points retenus</label><textarea id="cf_decisions" rows="4" spellcheck="true">${escapeHtml(s?.decisions||"")}</textarea></div>

    ${attachmentsSectionHtml(s)}
    `,
    `${s?`<button class="btn btn-danger" id="btnDeleteDos">Supprimer</button>`:""}<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveDos">${s?"Enregistrer":"Créer la session"}</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(s);
    document.getElementById("btnSaveDos").addEventListener("click", ()=>{
      const titre = document.getElementById("cf_titre").value.trim();
      if(!titre){ toast("Veuillez indiquer un titre."); return; }
      const data = {
        date: document.getElementById("cf_date").value || todayISO(),
        lieu: document.getElementById("cf_lieu").value.trim(),
        titre,
        participants: collectParticipants("cf_participants"),
        ordreDuJour: document.getElementById("cf_odj").value.trim(),
        decisions: document.getElementById("cf_decisions").value.trim(),
      };
      let rec = s;
      if(s){ Object.assign(s, data); toast("Session mise à jour."); }
      else { rec = { id: uid("sess"), ...data, structures:[], pieceJointes: consumePendingAttachments() }; d.sessions.push(rec); toast("Session enregistrée."); }
      syncAutoRappel("dosSession", rec.id, { date: rec.date, titre: `${rec.titre} — ${dossierMeta(key).name}`, lieu: rec.lieu, type: dossierMeta(key).name });
      saveState(); closeDrawer(); renderDossier(key); renderDashboard();
    });
    document.getElementById("btnDeleteDos")?.addEventListener("click", async ()=>{
      if(!await appConfirm("Supprimer cette session ?")) return;
      removeAutoRappel("dosSession", s.id);
      d.sessions = d.sessions.filter(x=>x.id!==s.id);
      saveState(); closeDrawer(); renderDossier(key); renderDashboard();
      toast("Session supprimée.");
    });
  });
}

function openDossierElementForm(key, sessionId, id){
  const d = dossierData(key);
  const s = d.sessions.find(x=>x.id===sessionId);
  if(!s) return;
  if(!s.structures) s.structures = [];
  const a = id ? s.structures.find(x=>x.id===id) : null;
  const label = dossierMeta(key);
  const html = drawerShell(
    (a?"Modifier l'élément — ":"Nouvel élément — ") + label.agrementTab,
    `
    <div class="field"><label>Nom de l'élément</label><input type="text" id="cf_structure" value="${escapeHtml(a?.structure||"")}" placeholder="Ex : Structure, point ou action suivie"></div>
    <div class="field-grid">
      <div class="field"><label>Date</label><input type="date" id="cf_datedemande" value="${a?.dateDemande||todayISO()}"></div>
      <div class="field"><label>Contact</label><input type="text" id="cf_contact" value="${escapeHtml(a?.contact||"")}" placeholder="Téléphone ou e-mail"></div>
    </div>
    <div class="field"><label>Statut</label>
      <select id="cf_statut">${["En instruction","Agréé","Rejeté"].map(s=>`<option ${(a?.statut||"En instruction")===s?"selected":""}>${s}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Observations</label><textarea id="cf_observations" rows="3" placeholder="Précisions sur cet élément…" spellcheck="true">${escapeHtml(a?.observations||"")}</textarea></div>

    ${attachmentsSectionHtml(a)}
    `,
    `${a?`<button class="btn btn-danger" id="btnDeleteDos">Supprimer</button>`:""}<div style="flex:1"></div><button class="btn" id="drawerCancel">Annuler</button><button class="btn btn-primary" id="btnSaveDos">${a?"Enregistrer":"Ajouter"}</button>`
  );
  openDrawer(html, ()=>{
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    setupAttachments(a);
    document.getElementById("btnSaveDos").addEventListener("click", ()=>{
      const structure = document.getElementById("cf_structure").value.trim();
      if(!structure){ toast("Veuillez indiquer un nom."); return; }
      const data = {
        structure,
        dateDemande: document.getElementById("cf_datedemande").value || todayISO(),
        contact: document.getElementById("cf_contact").value.trim(),
        statut: document.getElementById("cf_statut").value,
        observations: document.getElementById("cf_observations").value.trim(),
      };
      if(a){ Object.assign(a, data); toast("Élément mis à jour."); }
      else { const rec = { id: uid("agr"), ...data, missionsLiees:[], pieceJointes: consumePendingAttachments() }; s.structures.push(rec); toast("Élément enregistré."); }
      saveState(); closeDrawer(); openDossierSessionFiche(key, sessionId);
    });
    document.getElementById("btnDeleteDos")?.addEventListener("click", async ()=>{
      if(!await appConfirm("Retirer cet élément ?")) return;
      s.structures = s.structures.filter(x=>x.id!==a.id);
      saveState(); closeDrawer(); openDossierSessionFiche(key, sessionId);
      toast("Élément retiré.");
    });
  });
}

/* =========================================================================
   PARAMÈTRES / EXPORT
   ========================================================================= */

function renderParametres(){
  const box = document.getElementById("secteursList");
  box.innerHTML = state.secteurs.map((s,i)=>`
    <span class="badge badge-neutral" style="padding:6px 10px;">
      ${escapeHtml(s)}
      <button data-del-secteur="${i}" style="border:none;background:none;cursor:pointer;color:var(--danger);font-weight:700;margin-left:4px;">✕</button>
    </span>`).join("");
  box.querySelectorAll("[data-del-secteur]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.secteurs.splice(+btn.dataset.delSecteur,1);
      saveState(); renderParametres();
    });
  });

  const respBox = document.getElementById("responsablesList");
  if(!state.responsables.length){
    respBox.innerHTML = `<span class="text-muted" style="font-size:12.5px;">Aucun responsable enregistré pour le moment.</span>`;
  } else {
    respBox.innerHTML = state.responsables.map((r,i)=>`
      <span class="badge badge-neutral" style="padding:6px 10px;">
        ${escapeHtml(r)}
        <button data-del-responsable="${i}" style="border:none;background:none;cursor:pointer;color:var(--danger);font-weight:700;margin-left:4px;">✕</button>
      </span>`).join("");
  }
  respBox.querySelectorAll("[data-del-responsable]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.responsables.splice(+btn.dataset.delResponsable,1);
      saveState(); renderParametres();
    });
  });
  renderSafetySnapshotsList();
}

function renderSafetySnapshotsList(){
  const box = document.getElementById("safetySnapshotsList");
  if(!box) return;
  const snapshots = getSafetySnapshots();
  if(!snapshots.length){
    box.innerHTML = `<p class="text-muted" style="font-size:12.5px;">Aucune sauvegarde de sécurité pour le moment.</p>`;
    return;
  }
  box.innerHTML = snapshots.map(s=>{
    const dt = new Date(s.timestamp);
    const dateStr = dt.toLocaleDateString("fr-FR") + " à " + dt.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
    return `
    <div class="activity-item">
      <div class="activity-body">
        <div class="title">${escapeHtml(s.label)}</div>
        <div class="meta">${dateStr}</div>
      </div>
      <button class="btn btn-sm" data-restore-snapshot="${s.id}">Restaurer cette version</button>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-restore-snapshot]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const snap = getSafetySnapshots().find(s=>s.id===btn.dataset.restoreSnapshot);
      if(!snap) return;
      if(!await appConfirm(`Restaurer l'état du ${new Date(snap.timestamp).toLocaleString("fr-FR")} ("${snap.label}") ? Les données actuelles seront remplacées (elles seront elles-mêmes conservées 10 jours en sécurité).`)) return;
      takeSafetySnapshot("Avant restauration d'une version antérieure");
      state = deepClone(snap.state);
      saveState();
      toast("Version restaurée avec succès.");
      updateBellUI();
      goView("dashboard");
    });
  });
}
document.getElementById("btnAddSecteur").addEventListener("click", ()=>{
  const inp = document.getElementById("newSecteurInput");
  const v = inp.value.trim();
  if(!v) return;
  if(!state.secteurs.includes(v)) state.secteurs.push(v);
  inp.value = "";
  saveState(); renderParametres();
  toast("Secteur ajouté.");
});
document.getElementById("btnAddResponsable").addEventListener("click", ()=>{
  const inp = document.getElementById("newResponsableInput");
  const v = inp.value.trim();
  if(!v) return;
  if(!state.responsables.includes(v)) state.responsables.push(v);
  inp.value = "";
  saveState(); renderParametres();
  toast("Responsable ajouté.");
});

function downloadFile(filename, content, mime){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById("btnExportJson").addEventListener("click", ()=>{
  downloadFile(`sdcqn_sauvegarde_${todayISO()}.json`, JSON.stringify(state, null, 2), "application/json");
  toast("Sauvegarde exportée.");
});

document.getElementById("importFile").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try{
      const data = JSON.parse(reader.result);
      if(!data.missions || !data.echantillons) throw new Error("format invalide");
      if(!await appConfirm("Importer cette sauvegarde remplacera toutes les données actuelles. Continuer ?")) return;
      takeSafetySnapshot("Avant import d'une sauvegarde");
      state = { missions:data.missions||[], echantillons:data.echantillons||[], activites:data.activites||[], secteurs:data.secteurs||DEFAULT_SECTEURS.slice(), responsables:data.responsables||[], reunionsCodinorm:data.reunionsCodinorm||[], rappels:data.rappels||[], entreprises:data.entreprises||[], commissions:data.commissions||{ riz:{sessions:[],membres:[],actions:[],agrements:[]}, tabac:{sessions:[],membres:[],actions:[],agrements:[]} }, archives:data.archives||[], dossiers:data.dossiers||{} };
      saveState();
      toast("Sauvegarde importée avec succès. L'état précédent a été conservé 10 jours en sécurité (Données & export).");
      updateBellUI();
      goView("dashboard");
    }catch(err){
      toast("Fichier de sauvegarde invalide.");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

function csvEscape(v){
  const s = String(v ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

document.getElementById("btnExportMissionsCsv").addEventListener("click", ()=>{
  const rows = [["Référence","Date début","Date fin","Entreprise","Secteur","Lieu","Responsable","Statut","Statut (autre)","Objet","Observations"]];
  state.missions.forEach(m=> rows.push([m.ref,m.dateDebut,m.dateFin,m.entreprise,m.secteur,m.lieu,m.responsable,m.statut,m.statutAutre,m.objet,m.observations]));
  downloadFile(`missions_${todayISO()}.csv`, rows.map(r=>r.map(csvEscape).join(";")).join("\n"), "text/csv");
});
document.getElementById("btnExportEchCsv").addEventListener("click", ()=>{
  const rows = [["Référence","Produits prélevés","Numéros de lot","Entreprise","Date prélèvement","Date résultat","Statut","Observations labo"]];
  state.echantillons.forEach(e=>{
    const produits = (e.produits && e.produits.length) ? e.produits : (e.produit ? [{nom:e.produit}] : []);
    const lots = produits.map(p=>p.numeroLot).filter(Boolean).join(", ");
    rows.push([e.ref, produitsResume(e), lots, e.entreprise, e.datePrelevement, e.dateResultat, e.statut, e.observationsLabo]);
  });
  downloadFile(`echantillons_${todayISO()}.csv`, rows.map(r=>r.map(csvEscape).join(";")).join("\n"), "text/csv");
});



document.getElementById("btnRefreshAll")?.addEventListener("click", async ()=>{
  const btn = document.getElementById("btnRefreshAll");
  const status = document.getElementById("refreshAllStatus");
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Actualisation en cours…";
  status.textContent = "";
  try{
    if(syncCfg.enabled && syncCfg.url && !syncRequestInFlight){
      syncRequestInFlight = true;
      status.textContent = "Vérification des dernières données du serveur…";
      await pullStateFromServer(true);
      syncRequestInFlight = false;
    }
  }catch(err){
    syncRequestInFlight = false;
    status.textContent = "Serveur injoignable — les informations locales ont tout de même été réactualisées.";
  }
  // Réactualise systématiquement tout ce qui est visible dès maintenant (cloche
  // d'alertes, statut de synchronisation) et la vue actuellement affichée, quelle
  // qu'elle soit — pour que le prochain écran consulté soit lui aussi à jour.
  updateBellUI();
  updateSyncUI();
  updateAiUI();
  checkRappelNotifications();
  const current = document.querySelector(".nav-item.active")?.dataset.view || "parametres";
  goView(current);
  btn.disabled = false;
  btn.innerHTML = original;
  if(!status.textContent || status.textContent.startsWith("Vérification")){
    status.textContent = "Actualisé à " + new Date().toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit", second:"2-digit" }) + ".";
  }
  toast("Informations actualisées.");
});

/* =========================================================================
   RAPPORT D'ACTIVITÉ (Word / PDF)
   ========================================================================= */

function rapportDefaultDates(){
  const now = new Date();
  const debut = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  return { debut, fin: todayISO() };
}
(function initRapportDates(){
  const d = rapportDefaultDates();
  const dEl = document.getElementById("rapportDateDebut");
  const fEl = document.getElementById("rapportDateFin");
  if(dEl && !dEl.value) dEl.value = d.debut;
  if(fEl && !fEl.value) fEl.value = d.fin;
})();

function getRapportRange(){
  const debut = document.getElementById("rapportDateDebut").value || "0000-01-01";
  const fin = document.getElementById("rapportDateFin").value || "9999-12-31";
  return { debut, fin };
}
function inRange(dateStr, debut, fin){
  if(!dateStr) return false;
  return dateStr >= debut && dateStr <= fin;
}

/* ---------------------------- Rapport global (Bilan trimestriel officiel SDCQN) ---------------------------- */

const TRIMESTRE_LABELS = { 1:"1er trimestre", 2:"2ème trimestre", 3:"3ème trimestre", 4:"4ème trimestre" };

function trimestreRange(year, q){
  const startMonth = (q-1)*3;
  const debut = `${year}-${String(startMonth+1).padStart(2,"0")}-01`;
  const finDate = new Date(year, startMonth+3, 0);
  const fin = finDate.toISOString().slice(0,10);
  return { debut, fin };
}

function collectRapportDataForRange(debut, fin){
  const activites = state.activites.filter(a=> inRange(a.date, debut, fin)).sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  const codinorm = state.reunionsCodinorm.filter(c=> inRange(c.date, debut, fin)).sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  const missions = state.missions.filter(m=> inRange(m.dateDebut, debut, fin)).sort((a,b)=> (a.dateDebut||"").localeCompare(b.dateDebut||""));
  const commissionsSummary = Object.keys(state.commissions).map(key=>{
    const sessions = (commData(key).sessions||[]).filter(s=> inRange(s.date, debut, fin));
    return { key, nom: commissionMeta(key).name, sessions };
  });
  return { debut, fin, activites, codinorm, missions, commissionsSummary };
}

// Indicateurs (entreprises visitées / échantillons prélevés) pour les 4 trimestres de l'année, à des fins de comparaison.
function computeQuarterlyIndicators(year){
  return [1,2,3,4].map(q=>{
    const { debut, fin } = trimestreRange(year, q);
    const missions = state.missions.filter(m=> inRange(m.dateDebut, debut, fin));
    const groups = groupMissionsList(missions);
    const nbEntreprises = groups.reduce((s,g)=> s+groupNbEntreprises(g), 0);
    const nbEchantillons = groups.reduce((s,g)=> s+groupNbEchantillons(g), 0);
    return { q, label: TRIMESTRE_LABELS[q], nbEntreprises, nbEchantillons };
  });
}

function collectRapportData(){
  const { debut, fin } = getRapportRange();
  const activites = state.activites.filter(a=> inRange(a.date, debut, fin)).sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  const codinorm = state.reunionsCodinorm.filter(c=> inRange(c.date, debut, fin)).sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  const riz = (commData("riz")?.sessions||[]).filter(s=> inRange(s.date, debut, fin)).sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  const tabac = (commData("tabac")?.sessions||[]).filter(s=> inRange(s.date, debut, fin)).sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  const missions = state.missions.filter(m=> inRange(m.dateDebut, debut, fin)).sort((a,b)=> (a.dateDebut||"").localeCompare(b.dateDebut||""));
  return { debut, fin, activites, codinorm, riz, tabac, missions };
}

function renderRapportApercu(){
  const d = collectRapportData();
  document.getElementById("rapportDateDebut").addEventListener("change", renderRapportApercu, { once:true });
  document.getElementById("rapportDateFin").addEventListener("change", renderRapportApercu, { once:true });
  const box = document.getElementById("rapportApercu");
  const rows = [
    ["Réunions & activités", d.activites.length],
    ["Réunion CODINORM", d.codinorm.length],
    ["Commission Retraitement Riz — sessions", d.riz.length],
    ["Commission Tabac — sessions", d.tabac.length],
    ["Missions de contrôle", d.missions.length],
  ];
  box.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Rubrique</th><th>Éléments inclus (période sélectionnée)</th></tr></thead>
        <tbody>${rows.map(r=>`<tr><td>${escapeHtml(r[0])}</td><td class="mono">${r[1]}</td></tr>`).join("")}</tbody>
      </table>
    </div>
    <p class="text-muted" style="margin-top:10px; font-size:12px;">Période : ${fmtDate(d.debut)} → ${fmtDate(d.fin)}</p>
  `;
}

function downloadBlob(filename, blob){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* =========================================================================
   INTELLIGENCE ARTIFICIELLE — appel DIRECT à l'API Claude (Anthropic)
   Simple et fiable : une clé d'API est renseignée une fois sur ce poste
   (dans le navigateur/l'application, jamais envoyée ailleurs qu'à
   Anthropic), et l'application dialogue directement avec Claude — sans
   passer par un serveur intermédiaire. Fonctionne quel que soit le mode
   de synchronisation choisi (serveur classique, espace Google, ou même
   sans synchronisation du tout).
   ========================================================================= */

const AI_CFG_KEY = "sdcqn_ai_cfg";
let aiCfg = { enabled:false, apiKey:"", model:"claude-sonnet-5" };
try{
  const nativeSaved = nativeLoadSettings();
  if(nativeSaved && nativeSaved.aiCfg){
    aiCfg = Object.assign(aiCfg, nativeSaved.aiCfg);
  } else {
    const rawAiCfg = localStorage.getItem(AI_CFG_KEY);
    if(rawAiCfg) aiCfg = Object.assign(aiCfg, JSON.parse(rawAiCfg));
  }
}catch(e){}
function saveAiCfg(){
  localStorage.setItem(AI_CFG_KEY, JSON.stringify(aiCfg));
  nativeSaveSettings({ aiCfg });
  androidSaveSettingsAsync({ aiCfg });
}

function updateAiUI(){
  const pill = document.getElementById("aiPillSettings");
  const label = document.getElementById("aiLabelSettings");
  const detail = document.getElementById("aiStatusDetail");
  const keyInput = document.getElementById("aiKeyInput");
  const modelInput = document.getElementById("aiModelInput");
  const toggleBtn = document.getElementById("btnToggleAi");
  if(keyInput && document.activeElement !== keyInput) keyInput.value = aiCfg.apiKey || "";
  if(modelInput && document.activeElement !== modelInput) modelInput.value = aiCfg.model || "claude-sonnet-5";
  if(toggleBtn) toggleBtn.textContent = aiCfg.enabled ? "Désactiver l'IA" : "Activer l'IA";

  if(!pill || !label) return;
  pill.classList.remove("is-local","is-synced","is-error");
  if(aiCfg.enabled && aiCfg.apiKey){
    pill.classList.add("is-synced"); label.textContent = "IA activée";
    if(detail) detail.textContent = `Analyse IA active sur ce poste (modèle « ${aiCfg.model} »), utilisable sur le tableau de bord, les rapports, et l'analyse de fichiers — sans passer par un serveur intermédiaire.`;
  } else {
    pill.classList.add("is-local"); label.textContent = "Non configurée";
    if(detail) detail.textContent = "Collez une clé d'API Claude (console.anthropic.com) ci-dessus, puis cliquez sur « Activer l'IA ».";
  }
}

function aiReady(){ return !!(aiCfg.enabled && aiCfg.apiKey); }

// Appel direct à l'API Claude. `file` (facultatif) = { dataBase64, mimeType, fileName }.
// Les PDF et images sont envoyés tels quels (lecture native par Claude) ; Word et Excel
// sont d'abord convertis en texte localement (voir extractOfficeFileText) avant l'appel.
async function callClaudeAPI(prompt, file){
  if(!aiReady()) throw new Error("Renseignez et activez une clé d'API Claude dans « Données & export » → Intelligence artificielle.");
  let content = prompt;
  if(file && file.dataBase64){
    const mime = (file.mimeType||"").toLowerCase();
    if(mime === "application/pdf"){
      content = [ { type:"document", source:{ type:"base64", media_type:"application/pdf", data:file.dataBase64 } }, { type:"text", text:prompt } ];
    } else if(mime.startsWith("image/")){
      content = [ { type:"image", source:{ type:"base64", media_type:mime, data:file.dataBase64 } }, { type:"text", text:prompt } ];
    }
  }
  let res;
  try{
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": aiCfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: aiCfg.model || "claude-sonnet-5", max_tokens: 1400, messages: [{ role:"user", content }] }),
    });
  }catch(networkErr){
    throw new Error("Connexion à l'API Claude impossible (accès Internet indisponible).");
  }
  let data;
  try{ data = await res.json(); }
  catch(parseErr){ throw new Error(`Réponse inattendue de l'API Claude (HTTP ${res.status}).`); }
  if(!res.ok){
    const msg = (data.error && data.error.message) ? data.error.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").trim();
}

// Extrait le texte d'un fichier Word (.doc/.docx) ou Excel (.xls/.xlsx) directement dans
// le navigateur/l'application, hors-ligne — aucun serveur ni service externe nécessaire.
async function extractOfficeFileText(dataBase64, mimeType, fileName){
  const bytes = Uint8Array.from(atob(dataBase64), c=>c.charCodeAt(0));
  const isWord = mimeType.indexOf("wordprocessingml")>=0 || mimeType==="application/msword";
  if(isWord){
    if(typeof mammoth === "undefined") throw new Error("Le module de lecture Word n'a pas pu être chargé.");
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
    return result.value || "";
  }
  if(typeof XLSX === "undefined") throw new Error("Le module de lecture Excel n'a pas pu être chargé.");
  const wb = XLSX.read(bytes, { type:"array" });
  const lines = [];
  wb.SheetNames.forEach(name=>{
    lines.push(`--- Feuille : ${name} ---`);
    lines.push(XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS:"\t" }));
  });
  return lines.join("\n");
}

document.getElementById("btnTestAi")?.addEventListener("click", async ()=>{
  const key = document.getElementById("aiKeyInput").value.trim();
  const model = document.getElementById("aiModelInput").value.trim() || "claude-sonnet-5";
  if(!key){ toast("Veuillez saisir une clé d'API."); return; }
  toast("Test en cours…");
  const savedCfg = { ...aiCfg };
  aiCfg = { enabled:true, apiKey:key, model };
  try{
    const reply = await callClaudeAPI("Réponds uniquement par : OK");
    toast(reply ? "Connexion réussie à l'API Claude." : "Connexion établie, réponse vide.");
    saveAiCfg(); // La clé est retenue immédiatement, même sans cliquer sur "Activer l'IA".
  }catch(err){
    toast("Échec de la connexion : " + err.message);
    aiCfg = savedCfg;
  }
  updateAiUI();
});

document.getElementById("btnToggleAi")?.addEventListener("click", ()=>{
  if(!aiCfg.enabled){
    const key = document.getElementById("aiKeyInput").value.trim();
    if(!key){ toast("Veuillez saisir une clé d'API avant d'activer l'IA."); return; }
    aiCfg = { enabled:true, apiKey:key, model: document.getElementById("aiModelInput").value.trim() || "claude-sonnet-5" };
    toast("IA activée sur ce poste.");
  } else {
    aiCfg.enabled = false;
    toast("IA désactivée.");
  }
  saveAiCfg();
  updateAiUI();
});

document.getElementById("aiKeyInput")?.addEventListener("change", ()=>{
  if(!aiCfg.enabled) return;
  aiCfg.apiKey = document.getElementById("aiKeyInput").value.trim();
  saveAiCfg();
});
document.getElementById("aiModelInput")?.addEventListener("change", ()=>{
  if(!aiCfg.enabled) return;
  aiCfg.model = document.getElementById("aiModelInput").value.trim() || "claude-sonnet-5";
  saveAiCfg();
});

updateAiUI();

/* ---------------------------- Histogrammes (canvas, hors-ligne) ---------------------------- */

// Génère un histogramme en PNG (data URL) via un <canvas> hors-champ — aucune bibliothèque externe.
function makeBarChartDataUrl(title, labels, series, opts){
  opts = opts || {};
  const W = opts.width || 720, H = opts.height || 380;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0,0,W,H);

  const padL = 46, padR = 20, padT = 46, padB = 56;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const legendH = series.length > 1 ? 26 : 0;

  ctx.fillStyle = "#1C2521";
  ctx.font = "bold 16px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, W/2, 26);

  const maxVal = Math.max(1, ...series.flatMap(s=>s.data));
  const niceMax = Math.ceil(maxVal / 5) * 5 || 5;

  // Axes
  ctx.strokeStyle = "#E1DED4"; ctx.lineWidth = 1;
  for(let g=0; g<=5; g++){
    const y = padT + chartH - (g/5)*(chartH-legendH);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W-padR, y); ctx.stroke();
    ctx.fillStyle = "#5B6B63"; ctx.font = "10px Arial, sans-serif"; ctx.textAlign = "right";
    ctx.fillText(Math.round(niceMax*g/5), padL-6, y+3);
  }

  const groupW = chartW / labels.length;
  const barGap = 6;
  const barW = Math.max(6, (groupW - barGap*(series.length+1)) / series.length);

  labels.forEach((lab,i)=>{
    const groupX = padL + i*groupW;
    series.forEach((s,si)=>{
      const val = s.data[i] || 0;
      const barH = (val/niceMax) * (chartH-legendH);
      const x = groupX + barGap + si*(barW+barGap);
      const y = padT + (chartH-legendH) - barH;
      ctx.fillStyle = s.color || "#0B5D33";
      ctx.fillRect(x, y, barW, barH);
    });
    ctx.fillStyle = "#5B6B63"; ctx.font = "10.5px Arial, sans-serif"; ctx.textAlign = "center";
    ctx.save();
    const lx = groupX + groupW/2;
    const ly = padT + (chartH-legendH) + 16;
    ctx.translate(lx, ly);
    if(labels.length > 8){ ctx.rotate(-Math.PI/5); ctx.textAlign = "right"; }
    ctx.fillText(String(lab).slice(0,14), 0, 0);
    ctx.restore();
  });

  if(series.length > 1){
    let lx = padL;
    const ly = H - 16;
    series.forEach(s=>{
      ctx.fillStyle = s.color; ctx.fillRect(lx, ly-9, 11, 11);
      ctx.fillStyle = "#1C2521"; ctx.font = "11px Arial, sans-serif"; ctx.textAlign = "left";
      ctx.fillText(s.label, lx+16, ly);
      lx += 16 + ctx.measureText(s.label).width + 22;
    });
  }

  return canvas.toDataURL("image/png");
}

function dataUrlToUint8Array(dataUrl){
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ---------------------------- Statistiques pour l'IA et les histogrammes ---------------------------- */

function computeRapportStats(d){
  const groups = groupMissionsList(d.missions);
  const nbMissions = groups.length;
  const nbEntreprises = groups.reduce((s,g)=> s+groupNbEntreprises(g), 0);

  const echRows = collectEchRapportRows();
  const nbEchantillons = echRows.length;
  const nbConformePhysico = echRows.filter(r=>r.statutPhysico==="Conforme").length;
  const nbNonConformePhysico = echRows.filter(r=>r.statutPhysico==="Non conforme").length;
  const nbAttentePhysico = nbEchantillons - nbConformePhysico - nbNonConformePhysico;
  const nbConformeMicro = echRows.filter(r=>r.statutMicro==="Conforme").length;
  const nbNonConformeMicro = echRows.filter(r=>r.statutMicro==="Non conforme").length;
  const nbAttenteMicro = nbEchantillons - nbConformeMicro - nbNonConformeMicro;

  const monthMap = {};
  groups.forEach(g=>{
    const key = (g.dateDebut||"").slice(0,7);
    if(key) monthMap[key] = (monthMap[key]||0)+1;
  });

  const secteurMap = {};
  groups.forEach(g=>{ const s = g.secteur||"Non renseigné"; secteurMap[s] = (secteurMap[s]||0)+1; });

  return {
    nbMissions, nbEntreprises, nbEchantillons,
    nbConformePhysico, nbNonConformePhysico, nbAttentePhysico,
    nbConformeMicro, nbNonConformeMicro, nbAttenteMicro,
    monthMap, secteurMap,
    nbActivites: d.activites.length, nbCodinorm: d.codinorm.length,
    nbRiz: d.riz.length, nbTabac: d.tabac.length,
  };
}

function buildAiPrompt(d, stats){
  const pct = (n,total)=> total ? Math.round(n/total*100) : null;
  const txP = pct(stats.nbConformePhysico, stats.nbEchantillons);
  const txM = pct(stats.nbConformeMicro, stats.nbEchantillons);
  const secteurs = Object.entries(stats.secteurMap).map(([s,n])=>`${s} (${n})`).join(", ") || "non renseigné";
  return `Tu aides un service ivoirien de contrôle qualité (Sous-Direction du Contrôle de la Qualité et des Normes, Ministère du Commerce, de l'Industrie et de l'Artisanat) à rédiger le corps d'un rapport d'activité officiel, en français administratif clair et factuel, pour la période du ${fmtDate(d.debut)} au ${fmtDate(d.fin)}.

Données brutes de la période :
- Missions de contrôle réalisées : ${stats.nbMissions}
- Entreprises visitées : ${stats.nbEntreprises}
- Échantillons (produits) prélevés : ${stats.nbEchantillons}
- Conformité physicochimique : ${stats.nbConformePhysico} conformes, ${stats.nbNonConformePhysico} non conformes, ${stats.nbAttentePhysico} en attente${txP!==null?` (taux de conformité : ${txP}%)`:""}
- Conformité microbiologique : ${stats.nbConformeMicro} conformes, ${stats.nbNonConformeMicro} non conformes, ${stats.nbAttenteMicro} en attente${txM!==null?` (taux de conformité : ${txM}%)`:""}
- Réunions & activités : ${stats.nbActivites}
- Réunions CODINORM : ${stats.nbCodinorm}
- Sessions Commission Retraitement Riz : ${stats.nbRiz}
- Sessions Commission Tabac : ${stats.nbTabac}
- Répartition des missions par secteur d'activité : ${secteurs}

IMPORTANT — Structure ta réponse EXACTEMENT selon ce plan officiel (reproduis ces intitulés à l'identique, chacun précédé de "## ", puis le texte du paragraphe juste en dessous, sans liste à puces) :

## Introduction
(2-3 phrases situant le contexte et la période du présent rapport.)

## La préparation de la période
(Objectifs fixés pour la période et dispositions prises pour les atteindre — reste général si l'information n'est pas disponible dans les données.)

## Déroulement de la période
(Le cœur du rapport : missions réalisées, entreprises visitées, échantillons prélevés, résultats de conformité physicochimique et microbiologique, réunions et sessions de commissions tenues. C'est ici que les chiffres ci-dessus doivent être exploités et interprétés.)

## Difficultés rencontrées
(Uniquement si les données laissent apparaître un point de vigilance réel — ex. taux de non-conformité élevé, échantillons en attente prolongée. Sinon, indique simplement qu'aucune difficulté majeure n'a été relevée.)

## Recommandations
(1 à 2 recommandations concrètes et proportionnées aux données ci-dessus.)

N'invente aucun chiffre absent de la liste fournie. Reste factuel et sobre, dans le ton d'une note administrative ivoirienne.`;
}

document.getElementById("btnGenererAnalyseIa")?.addEventListener("click", async ()=>{
  const btn = document.getElementById("btnGenererAnalyseIa");
  const status = document.getElementById("aiAnalyseStatus");
  if(!aiReady()){
    toast("Renseignez et activez une clé IA dans « Données & export » → Intelligence artificielle.");
    return;
  }
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  status.textContent = "";
  try{
    const d = collectRapportData();
    const stats = computeRapportStats(d);
    const prompt = buildAiPrompt(d, stats);
    const text = await callClaudeAPI(prompt);
    document.getElementById("aiAnalyseText").value = text;
    document.getElementById("aiAnalyseWrap").hidden = false;
    status.textContent = "Analyse générée — à relire et valider avant diffusion.";
  }catch(err){
    status.textContent = "Erreur : " + err.message;
    toast("Échec de la génération de l'analyse IA.");
  }
  btn.disabled = false; btn.textContent = original;
});

document.getElementById("rgAnnee") && (document.getElementById("rgAnnee").value = new Date().getFullYear());
(function(){
  const now = new Date();
  const el = document.getElementById("rgTrimestre");
  if(el) el.value = String(Math.floor(now.getMonth()/3)+1);
})();

function buildRapportGlobalAiPrompt(data, quarterlyIndicators, year, qLabel){
  const totalEntreprises = quarterlyIndicators.reduce((s,q)=>s+q.nbEntreprises,0);
  const totalEchantillons = quarterlyIndicators.reduce((s,q)=>s+q.nbEchantillons,0);
  const missionsResume = data.missions.slice(0,20).map(m=> `${fmtDate(m.dateDebut)} — ${m.entreprise} (${m.secteur||"secteur non précisé"}) : ${m.objet||"objet non précisé"}`).join("; ") || "aucune mission enregistrée sur la période";
  const codinormResume = data.codinorm.map(c=> `${fmtDate(c.date)} — ${c.normeAnalysee||c.titre}`).join("; ") || "aucune réunion CODINORM sur la période";
  const commissionsResume = data.commissionsSummary.map(c=> `${c.nom} : ${c.sessions.length} session(s)`).join("; ") || "aucune";

  return `Tu aides un service ivoirien de contrôle qualité (Sous-Direction du Contrôle de la Qualité et des Normes, MCIA) à rédiger le corps d'un bilan d'activités officiel trimestriel destiné au Directeur de tutelle, pour le ${qLabel} de l'année ${year}.

Données de la période :
- Missions de contrôle menées : ${data.missions.length} (${missionsResume})
- Réunions CODINORM : ${data.codinorm.length} (${codinormResume})
- Commissions et comités : ${commissionsResume}
- Autres réunions/ateliers : ${data.activites.length}
- Cumul de l'année ${year} à ce stade : ${totalEntreprises} entreprises visitées, ${totalEchantillons} échantillons prélevés (tous trimestres confondus déjà enregistrés)

IMPORTANT — Structure ta réponse EXACTEMENT selon ce plan (reproduis ces intitulés à l'identique, chacun précédé de "## ") :

## Bilan des activités inscrites au Plan d'Actions Prioritaires
(1-2 phrases générales de synthèse ; si aucune information sur le PAP n'est disponible dans les données, indique sobrement que le détail sera renseigné par le responsable.)

## Commentaire CODINORM
(1-2 phrases commentant les réunions CODINORM listées ci-dessus, ou l'absence de réunion sur la période.)

## Bilan des commissions et comités
(1-2 phrases résumant l'activité des commissions/comités listés ci-dessus.)

## Difficultés rencontrées
(Uniquement des difficultés réellement suggérées par les données ; sinon indique qu'aucune difficulté majeure n'a été relevée.)

## Recommandations
(1 à 2 recommandations concrètes et proportionnées.)

N'invente aucun chiffre ni aucune information absente des données ci-dessus. Ton sobre et factuel, dans le style d'une note administrative ivoirienne.`;
}

function parseAiMarkedSections(text){
  const out = {};
  text.trim().split(/\n(?=##\s)/).filter(Boolean).forEach(part=>{
    const m = part.match(/^##\s*(.+?)\n([\s\S]*)$/);
    if(m) out[m[1].trim()] = m[2].trim();
  });
  return out;
}

document.getElementById("btnGenererRapportGlobalIa")?.addEventListener("click", async ()=>{
  const btn = document.getElementById("btnGenererRapportGlobalIa");
  const status = document.getElementById("rgAiStatus");
  if(!aiReady()){
    toast("Renseignez et activez une clé IA dans « Données & export » → Intelligence artificielle.");
    return;
  }
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  status.textContent = "";
  try{
    const year = parseInt(document.getElementById("rgAnnee").value, 10) || new Date().getFullYear();
    const q = parseInt(document.getElementById("rgTrimestre").value, 10) || 1;
    const { debut, fin } = trimestreRange(year, q);
    const data = collectRapportDataForRange(debut, fin);
    const indicators = computeQuarterlyIndicators(year);
    const prompt = buildRapportGlobalAiPrompt(data, indicators, year, TRIMESTRE_LABELS[q]);
    const text = await callClaudeAPI(prompt);
    document.getElementById("rgAiText").value = text;
    document.getElementById("rgAiWrap").hidden = false;
    status.textContent = "Texte généré — à relire et valider avant diffusion.";
  }catch(err){
    status.textContent = "Erreur : " + err.message;
    toast("Échec de la génération du bilan IA.");
  }
  btn.disabled = false; btn.textContent = original;
});

/* ---------------------------- Fichiers partagés (tableau de bord — compteur uniquement) ---------------------------- */

let dashFilesCache = [];

async function loadDashFiles(){
  const status = document.getElementById("dashFilesStatus");
  const countEl = document.getElementById("dashFilesCount");
  if(!syncCfg.enabled || !syncCfg.url){
    status.textContent = "Activez la synchronisation (Données & export) pour consulter et partager des fichiers.";
    countEl.textContent = "0";
    return;
  }
  status.textContent = "";
  try{
    dashFilesCache = await apiGet("/api/files");
    countEl.textContent = dashFilesCache.length;
    renderDashFileSearchResults();
  }catch(err){
    status.textContent = "Impossible de charger le nombre de fichiers (serveur injoignable ?).";
    countEl.textContent = "—";
  }
}
document.getElementById("btnRefreshDashFiles")?.addEventListener("click", async ()=>{
  const btn = document.getElementById("btnRefreshDashFiles");
  btn.classList.add("spinning");
  btn.disabled = true;
  await loadDashFiles();
  btn.classList.remove("spinning");
  btn.disabled = false;
  toast("Nombre de fichiers actualisé à partir du serveur.");
});

// Types de fichiers que Claude peut analyser directement (PDF et images).
const AI_ANALYZABLE_MIME_PREFIXES = [
  "application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
function isAiAnalyzableFile(mimeType){
  return AI_ANALYZABLE_MIME_PREFIXES.some(p => (mimeType||"").toLowerCase().startsWith(p));
}

function renderDashFileSearchResults(){
  const q = (document.getElementById("dashFileSearch")?.value || "").trim().toLowerCase();
  const box = document.getElementById("dashFileSearchResults");
  if(!box) return;
  // Le résultat d'une analyse IA précédente ne concerne plus forcément ce qui est affiché
  // dès que la recherche change (nouvelle requête, ou recherche effacée) : on l'efface.
  const analysisBox = document.getElementById("dashFileAnalysisResult");
  if(analysisBox) analysisBox.innerHTML = "";
  if(!q){ box.innerHTML = ""; return; }
  const matches = dashFilesCache.filter(f => (f.originalName||"").toLowerCase().includes(q)).slice(0, 25);
  if(!matches.length){
    box.innerHTML = `<p class="text-muted" style="font-size:12.5px;">Aucun fichier ne correspond à « ${escapeHtml(q)} ».</p>`;
    return;
  }
  box.innerHTML = matches.map(f => `
    <div class="attach-item">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="attach-name" title="${escapeHtml(f.originalName)}">${escapeHtml(f.originalName)}</span>
      <span class="attach-size">${formatFileSize(f.size)}</span>
      <button class="icon-btn" data-dl-file="${f.id}" title="Télécharger">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
      </button>
      ${isAiAnalyzableFile(f.mimeType) ? `<button class="btn btn-sm" data-analyze-file="${f.id}">✨ Analyser avec l'IA</button>` : ""}
    </div>`).join("");
  box.querySelectorAll("[data-dl-file]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const f = dashFilesCache.find(x=>x.id===btn.dataset.dlFile);
      if(f) downloadAttachment(f.id, f.originalName);
    });
  });
  box.querySelectorAll("[data-analyze-file]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const f = dashFilesCache.find(x=>x.id===btn.dataset.analyzeFile);
      if(f) analyzeFileWithAI(f);
    });
  });
}
document.getElementById("dashFileSearch")?.addEventListener("input", renderDashFileSearchResults);

// Récupère le contenu binaire (base64) d'un fichier déjà partagé, pour l'envoyer à l'IA.
async function fetchFileBase64(id){
  const base = normalizeServerUrl(syncCfg.url);
  if(isGasBackend(base)){
    const url = base + "?action=downloadFile&id=" + encodeURIComponent(id) + "&key=" + encodeURIComponent(syncCfg.key||"");
    const res = await fetch(url);
    if(!res.ok) throw new Error("HTTP "+res.status);
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    return data; // { originalName, mimeType, dataBase64 }
  }
  const f = dashFilesCache.find(x=>x.id===id);
  const url = base + "/api/files/" + id;
  const res = await fetch(url, { headers:{ "X-SDCQN-Key": syncCfg.key||"" } });
  if(!res.ok) throw new Error("HTTP "+res.status);
  const blob = await res.blob();
  const dataBase64 = await new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return { originalName: f?.originalName || "fichier", mimeType: f?.mimeType || blob.type, dataBase64 };
}

async function analyzeFileWithAI(fileMeta){
  const resultBox = document.getElementById("dashFileAnalysisResult");
  if(!aiReady()){
    toast("Renseignez et activez une clé IA dans « Données & export » → Intelligence artificielle.");
    return;
  }
  if(!isAiAnalyzableFile(fileMeta.mimeType)){
    toast("Ce type de fichier n'est pas pris en charge pour l'analyse IA (formats acceptés : PDF, JPG, PNG, GIF, WEBP, Word, Excel).");
    return;
  }
  resultBox.innerHTML = `<p class="text-muted" style="font-size:12.5px;">Analyse de « ${escapeHtml(fileMeta.originalName)} » en cours…</p>`;
  try{
    const full = await fetchFileBase64(fileMeta.id);
    const mime = (full.mimeType||"").toLowerCase();
    const isOffice = mime.indexOf("wordprocessingml")>=0 || mime==="application/msword" || mime.indexOf("spreadsheetml")>=0 || mime==="application/vnd.ms-excel";
    let prompt = `Tu aides un service ivoirien de contrôle qualité (Sous-Direction du Contrôle de la Qualité et des Normes, MCIA) à analyser un document joint dans l'application (nom du fichier : "${full.originalName}").

Analyse le contenu de ce document et rédige, en français :
1. Un résumé de ce qu'il contient (2-3 phrases).
2. Les éléments importants qui y figurent (dates, entreprises, produits, résultats, conclusions, anomalies…) si le document s'y prête.
3. Si le document semble sans rapport avec le contrôle qualité, décris simplement son contenu sans forcer une interprétation.

Ne fabrique aucune information qui ne figure pas réellement dans le document. Écris en paragraphes courts, sans liste à puces et sans titre.`;
    let text;
    if(isOffice){
      const extracted = await extractOfficeFileText(full.dataBase64, mime, full.originalName);
      if(!extracted.trim()) throw new Error("Le fichier semble vide ou n'a pas pu être lu.");
      prompt += `\n\n--- Contenu du document ---\n${extracted.slice(0, 60000)}`;
      text = await callClaudeAPI(prompt);
    } else {
      text = await callClaudeAPI(prompt, { dataBase64: full.dataBase64, mimeType: full.mimeType, fileName: full.originalName });
    }
    resultBox.innerHTML = `<div class="form-section-title">Analyse IA — ${escapeHtml(fileMeta.originalName)}</div><div class="ai-result-box">${escapeHtml(text)}</div><div class="ai-result-meta">Analyse générée par intelligence artificielle — à vérifier avant toute utilisation officielle.</div>`;
  }catch(err){
    resultBox.innerHTML = `<p class="text-muted" style="font-size:12.5px;">Erreur : ${escapeHtml(err.message)}</p>`;
    toast("Échec de l'analyse du fichier.");
  }
}


/* ---------------------------- Génération Word ---------------------------- */

/* ---------------------------- En-tête ministériel officiel (partagé Word) ---------------------------- */
// Reproduit l'en-tête bilingue des notes officielles de la SDCQN (modèle fourni par l'utilisateur) :
// colonne gauche = hiérarchie ministérielle, colonne droite = République de Côte d'Ivoire.
function buildOfficialLetterhead(docx, { objet, dateStr }){
  const { Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = docx;
  const noBorder = { style: BorderStyle.NONE, size:0, color:"FFFFFF" };
  const noBorders = { top:noBorder, bottom:noBorder, left:noBorder, right:noBorder };
  function txt(lines, opts){
    opts = opts || {};
    return lines.map(l => new Paragraph({
      alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing:{ after: 20 },
      children:[ new TextRun({ text:l, bold: !!opts.bold, size: opts.size||18 }) ]
    }));
  }
  const headerTable = new Table({
    width:{ size:100, type: WidthType.PERCENTAGE },
    borders: { top:noBorder, bottom:noBorder, left:noBorder, right:noBorder, insideHorizontal:noBorder, insideVertical:noBorder },
    rows:[ new TableRow({ children:[
      new TableCell({ width:{size:55,type:WidthType.PERCENTAGE}, borders:noBorders, children: txt(["MINISTÈRE DU COMMERCE, DE L'INDUSTRIE","ET DE L'ARTISANAT"], {bold:true, center:true, size:19}) }),
      new TableCell({ width:{size:45,type:WidthType.PERCENTAGE}, borders:noBorders, children: txt(["RÉPUBLIQUE DE CÔTE D'IVOIRE","Union – Discipline – Travail"], {bold:true, center:true, size:19}) }),
    ]}) ]
  });
  const children = [ headerTable, new Paragraph({ text:"" }) ];
  [
    "Direction Générale du Commerce Intérieur",
    "Direction de la Métrologie, du Contrôle",
    "de la Qualité et de la Répression des Fraudes",
    "Sous-Direction du Contrôle de la Qualité et des Normes",
  ].forEach(l => children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:20}, children:[ new TextRun({ text:l, bold:true, size:19 }) ] })));
  children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:20}, children:[ new TextRun({ text:"--------------", size:19 }) ] }));
  children.push(new Paragraph({ alignment:AlignmentType.RIGHT, spacing:{after:20}, children:[ new TextRun({ text:`Abidjan, le ${dateStr}`, size:19 }) ] }));
  children.push(new Paragraph({ spacing:{after:200}, children:[ new TextRun({ text:"N°________/MCIA/DGCI/DMRFCQ/SDCQN", size:19 }) ] }));
  children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:60}, children:[ new TextRun({ text:"NOTE À L'ATTENTION", bold:true, size:22 }) ] }));
  children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:200}, children:[ new TextRun({ text:"DE MONSIEUR LE DIRECTEUR DE LA MÉTROLOGIE, DU CONTRÔLE DE LA QUALITÉ ET DE LA RÉPRESSION DES FRAUDES", bold:true, size:20 }) ] }));
  children.push(new Paragraph({ spacing:{after:260}, children:[ new TextRun({ text:"Objet : ", bold:true, size:20 }), new TextRun({ text: objet, bold:true, size:20 }) ] }));
  return children;
}
function buildOfficialSignatureBlock(docx){
  const { Paragraph, TextRun, AlignmentType } = docx;
  return [
    new Paragraph({ spacing:{ before:400, after:260 }, alignment:AlignmentType.JUSTIFIED, children:[ new TextRun({ text:"Telle est, Monsieur le Directeur, l'économie du présent rapport soumis à votre appréciation.", size:20 }) ] }),
    new Paragraph({ alignment:AlignmentType.RIGHT, spacing:{ before:400, after:20 }, children:[ new TextRun({ text:"Le Sous-Directeur", size:19 }) ] }),
    new Paragraph({ alignment:AlignmentType.RIGHT, spacing:{ before:400 }, children:[ new TextRun({ text:"COULIBALY Kinampinan Adolphe", bold:true, size:19 }) ] }),
  ];
}

function buildWordReport(d, opts){
  opts = opts || {};
  const { Document, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, Packer } = docx;
  const GREEN = "0B5D33";

  function h1(text){
    return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing:{ before:280, after:140 }, children:[ new TextRun({ text, bold:true, color:GREEN }) ] });
  }
  function pMuted(text){
    return new Paragraph({ spacing:{ after:160 }, children:[ new TextRun({ text, italics:true, color:"5B6B63", size:20 }) ] });
  }
  function cell(text, opts){
    opts = opts || {};
    return new TableCell({
      width:{ size: opts.width||20, type: WidthType.PERCENTAGE },
      shading: opts.header ? { fill: GREEN, type: ShadingType.CLEAR, color:"auto" } : undefined,
      children:[ new Paragraph({ children:[ new TextRun({ text: String(text??"—"), bold: !!opts.header, color: opts.header ? "FFFFFF" : "1C2521", size:19 }) ] }) ]
    });
  }
  function table(headers, rows, widths){
    return new Table({
      width:{ size:100, type: WidthType.PERCENTAGE },
      rows:[
        new TableRow({ children: headers.map((hd,i)=> cell(hd,{header:true, width: widths?widths[i]:undefined})) }),
        ...rows.map(r => new TableRow({ children: r.map((v,i)=> cell(v,{width: widths?widths[i]:undefined})) }))
      ]
    });
  }
  function emptyNote(text){
    return new Paragraph({ spacing:{ after:200 }, children:[ new TextRun({ text, italics:true, color:"90998F", size:19 }) ] });
  }
  // Rend le texte généré par l'IA (sections marquées "## Titre") selon la numérotation romaine
  // du canevas officiel de rapport de période, plutôt qu'un simple bloc "Analyse et interprétation".
  function renderAiSections(text){
    const out = [];
    const parts = text.trim().split(/\n(?=##\s)/).filter(Boolean);
    let n = 0;
    const romans = ["I","II","III","IV","V","VI","VII"];
    parts.forEach(part=>{
      const m = part.match(/^##\s*(.+?)\n([\s\S]*)$/);
      const title = m ? m[1].trim() : null;
      const body = (m ? m[2] : part).trim();
      if(title){
        out.push(new Paragraph({ spacing:{ before:240, after:120 }, children:[ new TextRun({ text:`${romans[n]||(n+1)}. ${title}`, bold:true, color:GREEN, size:22 }) ] }));
        n++;
      }
      body.split(/\n+/).forEach(para=>{
        if(!para.trim()) return;
        out.push(new Paragraph({ spacing:{ after:140 }, alignment: AlignmentType.JUSTIFIED, children:[ new TextRun({ text: para.trim(), size:20 }) ] }));
      });
    });
    out.push(new Paragraph({ spacing:{ after:100 }, children:[ new TextRun({ text:"Texte rédigé avec l'assistance de l'intelligence artificielle — relu et validé par le responsable.", italics:true, size:15, color:"90998F" }) ] }));
    return out;
  }

  const children = buildOfficialLetterhead(docx, {
    objet: `Rapport d'activité de la Sous-direction du Contrôle de la Qualité et des Normes (SDCQN) pour la période du ${fmtDate(d.debut)} au ${fmtDate(d.fin)}.`,
    dateStr: fmtDate(todayISO()),
  });

  const stats = computeRapportStats(d);

  if(opts.analyseText && opts.analyseText.trim()){
    children.push(...renderAiSections(opts.analyseText));
  }

  if(opts.charts){
    children.push(h1("Indicateurs visuels"));
    const monthLabels = Object.keys(stats.monthMap).sort();
    if(monthLabels.length){
      const url1 = makeBarChartDataUrl("Missions par mois", monthLabels, [{ label:"Missions", data: monthLabels.map(k=>stats.monthMap[k]), color:"#0B5D33" }]);
      children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:200}, children:[ new ImageRun({ data: dataUrlToUint8Array(url1), transformation:{ width:520, height:275 }, type:"png" }) ] }));
    }
    if(stats.nbEchantillons){
      const url2 = makeBarChartDataUrl("Conformité des échantillons", ["Physicochimique","Microbiologique"], [
        { label:"Conforme", data:[stats.nbConformePhysico, stats.nbConformeMicro], color:"#1E7A3C" },
        { label:"Non conforme", data:[stats.nbNonConformePhysico, stats.nbNonConformeMicro], color:"#C0392B" },
        { label:"En attente", data:[stats.nbAttentePhysico, stats.nbAttenteMicro], color:"#B8791A" },
      ]);
      children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:200}, children:[ new ImageRun({ data: dataUrlToUint8Array(url2), transformation:{ width:520, height:275 }, type:"png" }) ] }));
    }
  }

  // 1. Réunions & activités
  children.push(h1("1. Réunions & activités"));
  if(!d.activites.length) children.push(emptyNote("Aucune réunion, atelier ou séminaire enregistré sur la période."));
  else children.push(table(
    ["Date","Type","Titre / objet","Lieu","Participants"],
    d.activites.map(a=>[fmtDate(a.date), a.type, a.titre, a.lieu||"—", a.participants||"—"]),
    [12,13,35,20,20]
  ));

  // 2. Réunion CODINORM
  children.push(h1("2. Réunion CODINORM"));
  if(!d.codinorm.length) children.push(emptyNote("Aucune réunion CODINORM enregistrée sur la période."));
  else children.push(table(
    ["Date","Titre / objet","Norme analysée","Lieu","Décisions / points retenus"],
    d.codinorm.map(c=>[fmtDate(c.date), c.titre, c.normeAnalysee||"—", c.lieu||"—", c.decisions||"—"]),
    [10,22,16,17,35]
  ));

  // 3. Commission Retraitement Riz
  children.push(h1("3. Commission Retraitement Riz"));
  if(!d.riz.length) children.push(emptyNote("Aucune session de la Commission Retraitement Riz enregistrée sur la période."));
  else children.push(table(
    ["Date","Titre / objet","Lieu","Décisions / points retenus"],
    d.riz.map(s=>[fmtDate(s.date), s.titre, s.lieu||"—", s.decisions||"—"]),
    [12,28,20,40]
  ));

  // 4. Commission Tabac
  children.push(h1("4. Commission Tabac"));
  if(!d.tabac.length) children.push(emptyNote("Aucune session de la Commission Tabac enregistrée sur la période."));
  else children.push(table(
    ["Date","Titre / objet","Lieu","Décisions / points retenus"],
    d.tabac.map(s=>[fmtDate(s.date), s.titre, s.lieu||"—", s.decisions||"—"]),
    [12,28,20,40]
  ));

  // 5. Missions de contrôle
  children.push(h1("5. Missions de contrôle"));
  if(!d.missions.length) children.push(emptyNote("Aucune mission de contrôle enregistrée sur la période."));
  else children.push(table(
    ["Période","Entreprise","Secteur","Lieu","Statut","Objet"],
    d.missions.map(m=>[
      (m.dateFin && m.dateFin!==m.dateDebut) ? `${fmtDate(m.dateDebut)}→${fmtDate(m.dateFin)}` : fmtDate(m.dateDebut),
      m.entreprise, m.secteur||"—", m.lieu||"—", m.statut||"—", m.objet||"—"
    ]),
    [14,18,14,14,12,28]
  ));

  children.push(...buildOfficialSignatureBlock(docx));

  const document = new Document({ sections:[{ properties:{}, children }] });
  return Packer.toBlob(document);
}

/* ---------------------------- Génération PDF ---------------------------- */

function buildPdfReport(d, opts){
  opts = opts || {};
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"a4" });
  const GREEN = [11,93,51];
  const MUTED = [91,107,99];
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 50;

  doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(0,0,0);
  doc.text("MINISTÈRE DU COMMERCE, DE L'INDUSTRIE", pageWidth/2-10, y, { align:"center" });
  doc.text("RÉPUBLIQUE DE CÔTE D'IVOIRE", pageWidth-150, y, { align:"center" }); y += 13;
  doc.text("ET DE L'ARTISANAT", pageWidth/2-10, y, { align:"center" });
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text("Union – Discipline – Travail", pageWidth-150, y, { align:"center" }); y += 22;
  doc.setFont("helvetica","bold"); doc.setFontSize(10);
  ["Direction Générale du Commerce Intérieur","Direction de la Métrologie, du Contrôle","de la Qualité et de la Répression des Fraudes","Sous-Direction du Contrôle de la Qualité et des Normes"].forEach(l=>{
    doc.text(l, pageWidth/2, y, { align:"center" }); y += 13;
  });
  y += 4;
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text(`Abidjan, le ${fmtDate(todayISO())}`, pageWidth-40, y, { align:"right" }); y += 14;
  doc.text("N°________/MCIA/DGCI/DMRFCQ/SDCQN", 40, y); y += 24;
  doc.setFont("helvetica","bold"); doc.setFontSize(13); doc.setTextColor(...GREEN);
  doc.text("NOTE À L'ATTENTION", pageWidth/2, y, { align:"center" }); y += 18;
  doc.setFontSize(10);
  const attnLines = doc.splitTextToSize("DE MONSIEUR LE DIRECTEUR DE LA MÉTROLOGIE, DU CONTRÔLE DE LA QUALITÉ ET DE LA REPRESSION DES FRAUDES", pageWidth-160);
  attnLines.forEach(l=>{ doc.text(l, pageWidth/2, y, { align:"center" }); y += 13; });
  y += 10;
  doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(30,30,30);
  const objetTxt = `Objet : Rapport d'activité de la Sous-direction du Contrôle de la Qualité et des Normes (SDCQN) pour la période du ${fmtDate(d.debut)} au ${fmtDate(d.fin)}.`;
  doc.splitTextToSize(objetTxt, pageWidth-80).forEach(l=>{ doc.text(l, 40, y); y += 14; });
  y += 14;

  const stats = computeRapportStats(d);

  if(opts.analyseText && opts.analyseText.trim()){
    const romans = ["I","II","III","IV","V","VI","VII"];
    let n = 0;
    opts.analyseText.trim().split(/\n(?=##\s)/).filter(Boolean).forEach(part=>{
      const m = part.match(/^##\s*(.+?)\n([\s\S]*)$/);
      const title = m ? m[1].trim() : null;
      const body = (m ? m[2] : part).trim();
      if(y > 740){ doc.addPage(); y = 50; }
      if(title){
        doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...GREEN);
        doc.text(`${romans[n]||(n+1)}. ${title}`, 40, y); y += 18;
        n++;
      }
      doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(30,30,30);
      body.split(/\n+/).forEach(para=>{
        if(!para.trim()) return;
        const lines = doc.splitTextToSize(para.trim(), pageWidth-80);
        lines.forEach(line=>{
          if(y > 780){ doc.addPage(); y = 50; }
          doc.text(line, 40, y); y += 13;
        });
        y += 6;
      });
    });
    doc.setFont("helvetica","italic"); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text("Texte rédigé avec l'assistance de l'intelligence artificielle — relu et validé par le responsable.", 40, y); y += 20;
  }

  if(opts.charts){
    const monthLabels = Object.keys(stats.monthMap).sort();
    if(monthLabels.length){
      if(y > 480){ doc.addPage(); y = 50; }
      const url1 = makeBarChartDataUrl("Missions par mois", monthLabels, [{ label:"Missions", data: monthLabels.map(k=>stats.monthMap[k]), color:"#0B5D33" }]);
      doc.addImage(url1, "PNG", 40, y, 400, 212); y += 226;
    }
    if(stats.nbEchantillons){
      if(y > 480){ doc.addPage(); y = 50; }
      const url2 = makeBarChartDataUrl("Conformité des échantillons", ["Physicochimique","Microbiologique"], [
        { label:"Conforme", data:[stats.nbConformePhysico, stats.nbConformeMicro], color:"#1E7A3C" },
        { label:"Non conforme", data:[stats.nbNonConformePhysico, stats.nbNonConformeMicro], color:"#C0392B" },
        { label:"En attente", data:[stats.nbAttentePhysico, stats.nbAttenteMicro], color:"#B8791A" },
      ]);
      doc.addImage(url2, "PNG", 40, y, 400, 212); y += 226;
    }
    y += 10;
  }

  function section(title, headers, rows, emptyText){
    if(y > 740){ doc.addPage(); y = 50; }
    doc.setFont("helvetica","bold"); doc.setFontSize(13); doc.setTextColor(...GREEN);
    doc.text(title, 40, y); y += 8;
    doc.setDrawColor(...GREEN); doc.setLineWidth(1); doc.line(40, y, pageWidth-40, y); y += 12;

    if(!rows.length){
      doc.setFont("helvetica","italic"); doc.setFontSize(10); doc.setTextColor(...MUTED);
      doc.text(emptyText, 40, y); y += 22;
      return;
    }
    doc.autoTable({
      startY: y,
      head: [headers],
      body: rows,
      margin:{ left:40, right:40 },
      styles:{ font:"helvetica", fontSize:9, cellPadding:5, overflow:"linebreak", valign:"top" },
      headStyles:{ fillColor:GREEN, textColor:255, fontStyle:"bold" },
      alternateRowStyles:{ fillColor:[247,245,240] },
      didDrawPage: ()=>{},
    });
    y = doc.lastAutoTable.finalY + 24;
  }

  section("1. Réunions & activités",
    ["Date","Type","Titre / objet","Lieu","Participants"],
    d.activites.map(a=>[fmtDate(a.date), a.type, a.titre, a.lieu||"—", a.participants||"—"]),
    "Aucune réunion, atelier ou séminaire enregistré sur la période.");

  section("2. Réunion CODINORM",
    ["Date","Titre / objet","Norme analysée","Lieu","Décisions / points retenus"],
    d.codinorm.map(c=>[fmtDate(c.date), c.titre, c.normeAnalysee||"—", c.lieu||"—", c.decisions||"—"]),
    "Aucune réunion CODINORM enregistrée sur la période.");

  section("3. Commission Retraitement Riz",
    ["Date","Titre / objet","Lieu","Décisions / points retenus"],
    d.riz.map(s=>[fmtDate(s.date), s.titre, s.lieu||"—", s.decisions||"—"]),
    "Aucune session de la Commission Retraitement Riz enregistrée sur la période.");

  section("4. Commission Tabac",
    ["Date","Titre / objet","Lieu","Décisions / points retenus"],
    d.tabac.map(s=>[fmtDate(s.date), s.titre, s.lieu||"—", s.decisions||"—"]),
    "Aucune session de la Commission Tabac enregistrée sur la période.");

  section("5. Missions de contrôle",
    ["Période","Entreprise","Secteur","Lieu","Statut","Objet"],
    d.missions.map(m=>[
      (m.dateFin && m.dateFin!==m.dateDebut) ? `${fmtDate(m.dateDebut)}→${fmtDate(m.dateFin)}` : fmtDate(m.dateDebut),
      m.entreprise, m.secteur||"—", m.lieu||"—", m.statut||"—", m.objet||"—"
    ]),
    "Aucune mission de contrôle enregistrée sur la période.");

  if(y > 680){ doc.addPage(); y = 50; }
  y += 20;
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(30,30,30);
  doc.splitTextToSize("Telle est, Monsieur le Directeur, l'économie du présent rapport soumis à votre appréciation.", pageWidth-80).forEach(l=>{ doc.text(l, 40, y); y += 14; });
  y += 30;
  doc.text("Le Sous-Directeur", pageWidth-40, y, { align:"right" }); y += 40;
  doc.setFont("helvetica","bold");
  doc.text("COULIBALY Kinampinan Adolphe", pageWidth-40, y, { align:"right" });

  return doc;
}

function getRapportOpts(){
  const charts = document.getElementById("rapportInclureHistogrammes")?.checked ?? true;
  const includeAnalyse = document.getElementById("rapportInclureAnalyse")?.checked ?? true;
  const analyseText = includeAnalyse ? (document.getElementById("aiAnalyseText")?.value || "") : "";
  return { charts, analyseText };
}

document.getElementById("btnRapportWord").addEventListener("click", async ()=>{
  const btn = document.getElementById("btnRapportWord");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  try{
    const d = collectRapportData();
    const blob = await buildWordReport(d, getRapportOpts());
    downloadBlob(`rapport_activite_${d.debut}_au_${d.fin}.docx`, blob);
    toast("Rapport Word généré.");
  }catch(err){
    console.error(err);
    toast("Erreur lors de la génération du rapport Word.");
  }
  btn.disabled = false; btn.textContent = original;
});

document.getElementById("btnRapportPdf").addEventListener("click", ()=>{
  const btn = document.getElementById("btnRapportPdf");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  try{
    const d = collectRapportData();
    const doc = buildPdfReport(d, getRapportOpts());
    doc.save(`rapport_activite_${d.debut}_au_${d.fin}.pdf`);
    toast("Rapport PDF généré.");
  }catch(err){
    console.error(err);
    toast("Erreur lors de la génération du rapport PDF.");
  }
  btn.disabled = false; btn.textContent = original;
});

/* ---------------------------- Rapport global (Bilan trimestriel — modèle officiel) ---------------------------- */

async function buildRapportGlobalWord(data, indicators, sections, year, qLabel, opts){
  opts = opts || {};
  const { Document, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, Packer } = docx;
  const GREEN = "0B5D33";

  function h1(text){ return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing:{ before:280, after:140 }, children:[ new TextRun({ text, bold:true, color:GREEN }) ] }); }
  function h2(text){ return new Paragraph({ spacing:{ before:200, after:100 }, children:[ new TextRun({ text, bold:true, size:21 }) ] }); }
  function pJust(text){ return new Paragraph({ spacing:{ after:140 }, alignment: AlignmentType.JUSTIFIED, children:[ new TextRun({ text, size:20 }) ] }); }
  function emptyNote(text){ return new Paragraph({ spacing:{ after:200 }, children:[ new TextRun({ text, italics:true, color:"90998F", size:19 }) ] }); }
  function cell(text, o){
    o = o || {};
    return new TableCell({
      width:{ size:o.width||20, type:WidthType.PERCENTAGE },
      shading: o.header ? { fill:GREEN, type:ShadingType.CLEAR, color:"auto" } : undefined,
      children:[ new Paragraph({ children:[ new TextRun({ text:String(text??"—"), bold:!!o.header, color:o.header?"FFFFFF":"1C2521", size:18 }) ] }) ]
    });
  }
  function table(headers, rows, widths){
    return new Table({ width:{size:100,type:WidthType.PERCENTAGE}, rows:[
      new TableRow({ children: headers.map((hh,i)=> cell(hh,{header:true,width:widths?widths[i]:undefined})) }),
      ...rows.map(r=> new TableRow({ children: r.map((v,i)=> cell(v,{width:widths?widths[i]:undefined})) }))
    ]});
  }

  const children = buildOfficialLetterhead(docx, {
    objet: `Bilan des activités de la Sous-direction du Contrôle de la Qualité et des Normes (SDCQN) au titre du ${qLabel} de l'année ${year}.`,
    dateStr: fmtDate(todayISO()),
  });

  children.push(h1("I. Bilan des activités inscrites au Plan d'Actions Prioritaires (PAP) " + year));
  children.push(pJust(sections["Bilan des activités inscrites au Plan d'Actions Prioritaires"] || "Aucune information disponible pour cette section."));

  children.push(h1("II. Bilan des activités hors Plan d'Actions Prioritaires (PAP) " + year));

  children.push(h2("A. Au titre des ateliers et réunions"));
  children.push(new Paragraph({ spacing:{after:100}, children:[ new TextRun({ text:"1. Réunion de CODINORM", bold:true, size:20 }) ] }));
  if(!data.codinorm.length) children.push(emptyNote("Aucune réunion CODINORM enregistrée sur la période."));
  else children.push(table(["N°","Dates","Libellés des normes"], data.codinorm.map((c,i)=>[i+1, fmtDate(c.date), c.normeAnalysee||c.titre||"—"]), [10,25,65]));
  children.push(pJust("Commentaire : " + (sections["Commentaire CODINORM"] || "—")));

  children.push(new Paragraph({ spacing:{before:160, after:100}, children:[ new TextRun({ text:"2. Autres réunions et ateliers", bold:true, size:20 }) ] }));
  if(!data.activites.length) children.push(emptyNote("Aucune autre réunion ou atelier enregistré sur la période."));
  else children.push(table(["Dates","Intitulés"], data.activites.map(a=>[fmtDate(a.date), a.titre]), [25,75]));

  children.push(h2("B. Au titre des commissions et comités"));
  if(!data.commissionsSummary.some(c=>c.sessions.length)) children.push(emptyNote("Aucune session de commission ou de comité enregistrée sur la période."));
  else children.push(table(["Commission / Comité","Sessions tenues"], data.commissionsSummary.map(c=>[c.nom, c.sessions.length]), [70,30]));
  children.push(pJust(sections["Bilan des commissions et comités"] || "—"));

  children.push(h2("C. Au titre des missions de contrôle qualité"));
  const groups = groupMissionsList(data.missions);
  if(!groups.length) children.push(emptyNote("Aucune mission de contrôle qualité enregistrée sur la période."));
  else children.push(table(
    ["Date","Activités menées","Objectifs","Structures / échantillons","Résultats obtenus","Observations"],
    groups.map(g=>{
      const period = (g.dateFin && g.dateFin!==g.dateDebut) ? `${fmtDate(g.dateDebut)} au ${fmtDate(g.dateFin)}` : fmtDate(g.dateDebut);
      const nbE = groupNbEntreprises(g), nbEch = groupNbEchantillons(g);
      const echGroupe = state.echantillons.filter(e=> g.members.some(v=>v.id===e.missionId));
      const produits = echGroupe.flatMap(e=>e.produits||[]);
      const nbConf = produits.filter(p=>(p.statutPhysico||p.statut)==="Conforme" && (p.statutMicro||p.statut)==="Conforme").length;
      const nbNonConf = produits.filter(p=>(p.statutPhysico||p.statut)==="Non conforme" || (p.statutMicro||p.statut)==="Non conforme").length;
      return [period, g.objet||"—", g.secteur||"—", `${nbE} structure(s) visitée(s) ; ${nbEch} échantillon(s) prélevé(s)`, `${nbConf} conforme(s), ${nbNonConf} non conforme(s)`, g.members.map(v=>v.observations).filter(Boolean).join(" / ")||"—"];
    }),
    [12,18,14,20,18,18]
  ));

  children.push(new Paragraph({ spacing:{before:200, after:100}, children:[ new TextRun({ text:"Indicateurs — année " + year, bold:true, size:20 }) ] }));
  children.push(table(
    ["N°","Indicateurs", TRIMESTRE_LABELS[1]+" "+year, TRIMESTRE_LABELS[2]+" "+year, TRIMESTRE_LABELS[3]+" "+year, TRIMESTRE_LABELS[4]+" "+year],
    [
      [1,"Nombre d'entreprises visitées", ...indicators.map(x=>x.nbEntreprises)],
      [2,"Nombre d'échantillons prélevés", ...indicators.map(x=>x.nbEchantillons)],
    ],
    [7,28,16,16,16,17]
  ));

  if(opts.charts !== false){
    children.push(new Paragraph({ spacing:{before:200, after:100}, children:[ new TextRun({ text:"Histogramme pour les indicateurs", bold:true, size:20 }) ] }));
    const labels = indicators.map(x=>x.label);
    const url = makeBarChartDataUrl("Indicateurs " + year, labels, [
      { label:"Entreprises visitées", data: indicators.map(x=>x.nbEntreprises), color:"#0B5D33" },
      { label:"Échantillons prélevés", data: indicators.map(x=>x.nbEchantillons), color:"#E87722" },
    ]);
    children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:200}, children:[ new ImageRun({ data: dataUrlToUint8Array(url), transformation:{ width:500, height:265 }, type:"png" }) ] }));
  }

  children.push(h1("III. Difficultés rencontrées"));
  children.push(pJust(sections["Difficultés rencontrées"] || "Aucune difficulté majeure n'a été relevée sur la période."));

  children.push(h1("IV. Recommandations"));
  children.push(pJust(sections["Recommandations"] || "—"));

  children.push(...buildOfficialSignatureBlock(docx));

  const document = new Document({ sections:[{ properties:{}, children }] });
  return Packer.toBlob(document);
}

function buildRapportGlobalPdf(data, indicators, sections, year, qLabel, opts){
  opts = opts || {};
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"a4" });
  const GREEN = [11,93,51];
  const MUTED = [91,107,99];
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  let y = 50;

  function checkPage(need){ if(y > pageHeight - (need||60)){ doc.addPage(); y = 50; } }
  function sectionTitle(t){ checkPage(60); doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...GREEN); doc.text(t, 40, y); y += 18; }
  function subTitle(t){ checkPage(40); doc.setFont("helvetica","bold"); doc.setFontSize(10.5); doc.setTextColor(30,30,30); doc.text(t, 40, y); y += 15; }
  function para(t){
    doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(30,30,30);
    doc.splitTextToSize(t, pageWidth-80).forEach(line=>{ checkPage(30); doc.text(line, 40, y); y += 13; });
    y += 8;
  }
  function miniTable(headers, rows, widths){
    checkPage(40);
    const totalW = pageWidth-80; const w = widths.map(p=> totalW*p/100);
    doc.setFont("helvetica","bold"); doc.setFontSize(8.5); doc.setFillColor(...GREEN); doc.setTextColor(255,255,255);
    let x = 40; const rh = 16;
    doc.rect(40, y, totalW, rh, "F");
    headers.forEach((hh,i)=>{ doc.text(String(hh), x+4, y+11); x += w[i]; });
    y += rh;
    doc.setFont("helvetica","normal"); doc.setTextColor(30,30,30);
    rows.forEach((r,ri)=>{
      const cellsLines = r.map((v,i)=> doc.splitTextToSize(String(v??"—"), w[i]-6));
      const lineCount = Math.max(...cellsLines.map(c=>c.length),1);
      const rowH = lineCount*11+6;
      checkPage(rowH+4);
      if(ri%2===1){ doc.setFillColor(251,250,247); doc.rect(40,y,totalW,rowH,"F"); }
      x = 40;
      cellsLines.forEach((lines,i)=>{ lines.forEach((line,li)=> doc.text(line, x+4, y+11+li*11)); x += w[i]; });
      y += rowH;
    });
    y += 10;
  }

  doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(0,0,0);
  doc.text("MINISTÈRE DU COMMERCE, DE L'INDUSTRIE", pageWidth/2-10, y, { align:"center" });
  doc.text("RÉPUBLIQUE DE CÔTE D'IVOIRE", pageWidth-150, y, { align:"center" }); y += 13;
  doc.text("ET DE L'ARTISANAT", pageWidth/2-10, y, { align:"center" });
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text("Union – Discipline – Travail", pageWidth-150, y, { align:"center" }); y += 22;
  doc.setFont("helvetica","bold"); doc.setFontSize(10);
  ["Direction Générale du Commerce Intérieur","Direction de la Métrologie, du Contrôle","de la Qualité et de la Répression des Fraudes","Sous-Direction du Contrôle de la Qualité et des Normes"].forEach(l=>{
    doc.text(l, pageWidth/2, y, { align:"center" }); y += 13;
  });
  y += 6;
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text(`Abidjan, le ${fmtDate(todayISO())}`, pageWidth-40, y, { align:"right" }); y += 14;
  doc.text("N°________/MCIA/DGCI/DMRFCQ/SDCQN", 40, y); y += 24;
  doc.setFont("helvetica","bold"); doc.setFontSize(13); doc.setTextColor(...GREEN);
  doc.text("NOTE À L'ATTENTION", pageWidth/2, y, { align:"center" }); y += 18;
  doc.setFontSize(10);
  doc.splitTextToSize("DE MONSIEUR LE DIRECTEUR DE LA MÉTROLOGIE, DU CONTRÔLE DE LA QUALITÉ ET DE LA REPRESSION DES FRAUDES", pageWidth-160).forEach(l=>{ doc.text(l, pageWidth/2, y, { align:"center" }); y += 13; });
  y += 10;
  doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(30,30,30);
  doc.splitTextToSize(`Objet : Bilan des activités de la SDCQN au titre du ${qLabel} de l'année ${year}.`, pageWidth-80).forEach(l=>{ doc.text(l, 40, y); y += 14; });
  y += 16;

  sectionTitle("I. Bilan des activités inscrites au Plan d'Actions Prioritaires (PAP) " + year);
  para(sections["Bilan des activités inscrites au Plan d'Actions Prioritaires"] || "Aucune information disponible pour cette section.");

  sectionTitle("II. Bilan des activités hors Plan d'Actions Prioritaires (PAP) " + year);
  subTitle("A. Au titre des ateliers et réunions — 1. Réunion de CODINORM");
  if(!data.codinorm.length){ doc.setFont("helvetica","italic"); doc.setFontSize(9); doc.setTextColor(...MUTED); checkPage(20); doc.text("Aucune réunion CODINORM enregistrée sur la période.", 40, y); y += 20; }
  else miniTable(["N°","Dates","Libellés des normes"], data.codinorm.map((c,i)=>[i+1, fmtDate(c.date), c.normeAnalysee||c.titre||"—"]), [10,25,65]);
  para("Commentaire : " + (sections["Commentaire CODINORM"] || "—"));

  subTitle("2. Autres réunions et ateliers");
  if(!data.activites.length){ doc.setFont("helvetica","italic"); doc.setFontSize(9); doc.setTextColor(...MUTED); checkPage(20); doc.text("Aucune autre réunion ou atelier enregistré sur la période.", 40, y); y += 20; }
  else miniTable(["Dates","Intitulés"], data.activites.map(a=>[fmtDate(a.date), a.titre]), [25,75]);

  subTitle("B. Au titre des commissions et comités");
  if(!data.commissionsSummary.some(c=>c.sessions.length)){ doc.setFont("helvetica","italic"); doc.setFontSize(9); doc.setTextColor(...MUTED); checkPage(20); doc.text("Aucune session de commission ou de comité enregistrée sur la période.", 40, y); y += 20; }
  else miniTable(["Commission / Comité","Sessions tenues"], data.commissionsSummary.map(c=>[c.nom, c.sessions.length]), [70,30]);
  para(sections["Bilan des commissions et comités"] || "—");

  subTitle("C. Au titre des missions de contrôle qualité");
  const groups = groupMissionsList(data.missions);
  if(!groups.length){ doc.setFont("helvetica","italic"); doc.setFontSize(9); doc.setTextColor(...MUTED); checkPage(20); doc.text("Aucune mission de contrôle qualité enregistrée sur la période.", 40, y); y += 20; }
  else miniTable(
    ["Date","Activités menées","Structures / échantillons","Résultats obtenus"],
    groups.map(g=>{
      const period = (g.dateFin && g.dateFin!==g.dateDebut) ? `${fmtDate(g.dateDebut)} au ${fmtDate(g.dateFin)}` : fmtDate(g.dateDebut);
      const nbE = groupNbEntreprises(g), nbEch = groupNbEchantillons(g);
      const echGroupe = state.echantillons.filter(e=> g.members.some(v=>v.id===e.missionId));
      const produits = echGroupe.flatMap(e=>e.produits||[]);
      const nbConf = produits.filter(p=>(p.statutPhysico||p.statut)==="Conforme" && (p.statutMicro||p.statut)==="Conforme").length;
      const nbNonConf = produits.filter(p=>(p.statutPhysico||p.statut)==="Non conforme" || (p.statutMicro||p.statut)==="Non conforme").length;
      return [period, g.objet||"—", `${nbE} struct. ; ${nbEch} éch.`, `${nbConf} conf., ${nbNonConf} non conf.`];
    }),
    [15,35,25,25]
  );

  checkPage(80);
  subTitle("Indicateurs — année " + year);
  miniTable(
    ["Indicateurs", TRIMESTRE_LABELS[1], TRIMESTRE_LABELS[2], TRIMESTRE_LABELS[3], TRIMESTRE_LABELS[4]],
    [
      ["Entreprises visitées", ...indicators.map(x=>x.nbEntreprises)],
      ["Échantillons prélevés", ...indicators.map(x=>x.nbEchantillons)],
    ],
    [30,17.5,17.5,17.5,17.5]
  );

  if(opts.charts !== false){
    checkPage(240);
    const labels = indicators.map(x=>x.label);
    const url = makeBarChartDataUrl("Indicateurs " + year, labels, [
      { label:"Entreprises visitées", data: indicators.map(x=>x.nbEntreprises), color:"#0B5D33" },
      { label:"Échantillons prélevés", data: indicators.map(x=>x.nbEchantillons), color:"#E87722" },
    ]);
    doc.addImage(url, "PNG", 40, y, 420, 222); y += 236;
  }

  sectionTitle("III. Difficultés rencontrées");
  para(sections["Difficultés rencontrées"] || "Aucune difficulté majeure n'a été relevée sur la période.");
  sectionTitle("IV. Recommandations");
  para(sections["Recommandations"] || "—");

  checkPage(120);
  y += 10;
  para("Telle est, Monsieur le Directeur, l'économie du présent rapport soumis à votre appréciation.");
  y += 30;
  doc.setFont("helvetica","normal"); doc.setFontSize(10);
  doc.text("Le Sous-Directeur", pageWidth-40, y, { align:"right" }); y += 40;
  doc.setFont("helvetica","bold");
  doc.text("COULIBALY Kinampinan Adolphe", pageWidth-40, y, { align:"right" });

  return doc;
}

document.getElementById("btnRapportGlobalWord")?.addEventListener("click", async ()=>{
  const btn = document.getElementById("btnRapportGlobalWord");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  try{
    const year = parseInt(document.getElementById("rgAnnee").value, 10) || new Date().getFullYear();
    const q = parseInt(document.getElementById("rgTrimestre").value, 10) || 1;
    const { debut, fin } = trimestreRange(year, q);
    const data = collectRapportDataForRange(debut, fin);
    const indicators = computeQuarterlyIndicators(year);
    const sections = parseAiMarkedSections(document.getElementById("rgAiText").value || "");
    const blob = await buildRapportGlobalWord(data, indicators, sections, year, TRIMESTRE_LABELS[q], { charts: document.getElementById("rapportInclureHistogrammes")?.checked ?? true });
    downloadBlob(`bilan_sdcqn_T${q}_${year}.docx`, blob);
    toast("Bilan global (Word) généré.");
  }catch(err){
    console.error(err);
    toast("Erreur lors de la génération du bilan global.");
  }
  btn.disabled = false; btn.textContent = original;
});

document.getElementById("btnRapportGlobalPdf")?.addEventListener("click", ()=>{
  const btn = document.getElementById("btnRapportGlobalPdf");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  try{
    const year = parseInt(document.getElementById("rgAnnee").value, 10) || new Date().getFullYear();
    const q = parseInt(document.getElementById("rgTrimestre").value, 10) || 1;
    const { debut, fin } = trimestreRange(year, q);
    const data = collectRapportDataForRange(debut, fin);
    const indicators = computeQuarterlyIndicators(year);
    const sections = parseAiMarkedSections(document.getElementById("rgAiText").value || "");
    const doc = buildRapportGlobalPdf(data, indicators, sections, year, TRIMESTRE_LABELS[q], { charts: document.getElementById("rapportInclureHistogrammes")?.checked ?? true });
    doc.save(`bilan_sdcqn_T${q}_${year}.pdf`);
    toast("Bilan global (PDF) généré.");
  }catch(err){
    console.error(err);
    toast("Erreur lors de la génération du bilan global.");
  }
  btn.disabled = false; btn.textContent = original;
});

/* ---------------------------- Rapport des échantillons (canevas officiel) ---------------------------- */

// Une ligne par produit prélevé (un échantillon peut contenir plusieurs produits)
function collectEchRapportRows(){
  const { debut, fin } = getRapportRange();
  const rows = [];
  state.echantillons.forEach(e=>{
    const mission = state.missions.find(m=>m.id===e.missionId);
    const dateVisite = mission?.dateVisite || e.datePrelevement || "";
    if(!inRange(dateVisite, debut, fin)) return;
    const produits = (e.produits && e.produits.length) ? e.produits : (e.produit ? [{nom:e.produit}] : []);
    produits.forEach(p=>{
      rows.push({
        dateVisite,
        structure: e.entreprise || "—",
        produit: p.nom || "—",
        dateProduction: p.dateProduction || "",
        dateExpiration: p.dateExpiration || "",
        statutPhysico: p.statutPhysico || p.statut || "En attente",
        statutMicro: p.statutMicro || p.statut || "En attente",
      });
    });
  });
  rows.sort((a,b)=> (a.dateVisite||"").localeCompare(b.dateVisite||""));
  return rows;
}

function echRapportTitre(debut, fin){
  const anDebut = (debut||"").slice(0,4), anFin = (fin||"").slice(0,4);
  if(anDebut && anDebut === anFin) return `LES ECHANTILLONS PRELEVES EN ${anDebut}`;
  return `LES ECHANTILLONS PRELEVES DU ${fmtDate(debut)} AU ${fmtDate(fin)}`;
}

function buildEchAiPrompt(rows, debut, fin){
  const nbCP = rows.filter(r=>r.statutPhysico==="Conforme").length;
  const nbNP = rows.filter(r=>r.statutPhysico==="Non conforme").length;
  const nbAP = rows.length - nbCP - nbNP;
  const nbCM = rows.filter(r=>r.statutMicro==="Conforme").length;
  const nbNM = rows.filter(r=>r.statutMicro==="Non conforme").length;
  const nbAM = rows.length - nbCM - nbNM;
  const nonConformes = rows.filter(r=> r.statutPhysico==="Non conforme" || r.statutMicro==="Non conforme")
    .map(r=> `${r.produit} (${r.structure})`).slice(0,15).join(", ");
  const structures = [...new Set(rows.map(r=>r.structure))];

  return `Tu aides un service ivoirien de contrôle qualité (Sous-Direction du Contrôle de la Qualité et des Normes, MCIA) à rédiger la section "Analyse et interprétation" du rapport des échantillons prélevés, en français, pour la période du ${fmtDate(debut)} au ${fmtDate(fin)}.

Données brutes de la période :
- Nombre total de produits échantillonnés : ${rows.length}
- Nombre de structures (entreprises) concernées : ${structures.length}
- Conformité physicochimique : ${nbCP} conformes, ${nbNP} non conformes, ${nbAP} en attente
- Conformité microbiologique : ${nbCM} conformes, ${nbNM} non conformes, ${nbAM} en attente
- Produits non conformes (physicochimique et/ou microbiologique) : ${nonConformes || "aucun"}

Rédige un texte de 2 à 4 paragraphes courts, en français administratif clair et factuel :
1. Résume le volume d'échantillons prélevés et de structures contrôlées sur la période.
2. Analyse et interprète les résultats de conformité physicochimique et microbiologique.
3. Si des produits sont non conformes, signale-le sans dramatiser, en invitant à un suivi (contre-visite, mise en demeure selon la procédure du service) — sans jamais inventer de décision qui n'a pas été prise.

N'invente aucun chiffre ni aucune structure absente de la liste ci-dessus. Écris en paragraphes rédigés, sans liste à puces et sans titre.`;
}

document.getElementById("btnGenererAnalyseIaEch")?.addEventListener("click", async ()=>{
  const btn = document.getElementById("btnGenererAnalyseIaEch");
  const status = document.getElementById("aiAnalyseEchStatus");
  if(!aiReady()){
    toast("Renseignez et activez une clé IA dans « Données & export » → Intelligence artificielle.");
    return;
  }
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  status.textContent = "";
  try{
    const { debut, fin } = getRapportRange();
    const rows = collectEchRapportRows();
    if(!rows.length){ toast("Aucun échantillon sur la période choisie — rien à analyser."); btn.disabled=false; btn.textContent=original; return; }
    const prompt = buildEchAiPrompt(rows, debut, fin);
    const text = await callClaudeAPI(prompt);
    document.getElementById("aiAnalyseEchText").value = text;
    document.getElementById("aiAnalyseEchWrap").hidden = false;
    status.textContent = "Analyse générée — à relire et valider avant diffusion.";
  }catch(err){
    status.textContent = "Erreur : " + err.message;
    toast("Échec de la génération de l'analyse IA.");
  }
  btn.disabled = false; btn.textContent = original;
});

function buildEchWordReport(rows, debut, fin, opts){
  opts = opts || {};
  const { Document, Paragraph, TextRun, ImageRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, Packer } = docx;
  const GREEN = "0B5D33";

  function headerLine(text, opts){
    opts = opts || {};
    return new Paragraph({
      alignment: AlignmentType.CENTER, spacing:{ after: opts.after ?? 20 },
      children:[ new TextRun({ text, bold: opts.bold!==false, size: opts.size||20 }) ]
    });
  }
  function headerCell(lines){
    return new TableCell({
      width:{ size:50, type:WidthType.PERCENTAGE },
      borders:{ top:{style:"none"}, bottom:{style:"none"}, left:{style:"none"}, right:{style:"none"} },
      children: lines,
    });
  }
  function cell(text, opts){
    opts = opts || {};
    return new TableCell({
      width:{ size: opts.width||12, type: WidthType.PERCENTAGE },
      shading: opts.header ? { fill: GREEN, type: ShadingType.CLEAR, color:"auto" } : undefined,
      children:[ new Paragraph({ alignment: opts.header?AlignmentType.CENTER:undefined, children:[ new TextRun({ text: String(text??"—"), bold: !!opts.header, color: opts.header ? "FFFFFF" : "1C2521", size:18 }) ] }) ]
    });
  }

  const headerTable = new Table({
    width:{ size:100, type:WidthType.PERCENTAGE },
    borders:{ top:{style:"none"}, bottom:{style:"none"}, left:{style:"none"}, right:{style:"none"}, insideHorizontal:{style:"none"}, insideVertical:{style:"none"} },
    rows:[ new TableRow({ children:[
      headerCell([
        headerLine("MINISTERE DU COMMERCE"),
        headerLine("ET DE L'INDUSTRIE"),
        headerLine("--------------", {size:18, bold:false}),
        headerLine("DIRECTION GENERALE DU COMMERCE INTERIEUR", {size:18}),
        headerLine("---------------", {size:18, bold:false}),
        headerLine("DIRECTION DE LA METROLOGIE, DE LA REPRESSION DES", {size:18}),
        headerLine("FRAUDES ET DU CONTRÔLE DE LA QUALITE", {size:18}),
        headerLine("----------------", {size:18, bold:false}),
        headerLine("SOUS – DIRECTION DU CONTROLE DE LA QUALITE ET DES NORMES", {size:18}),
        headerLine("----------------", {size:18, bold:false, after:0}),
      ]),
      headerCell([
        headerLine("REPUBLIQUE DE COTE D'IVOIRE"),
        headerLine("Union-Discipline-Travail"),
        headerLine("--------------", {size:18, bold:false, after:0}),
      ]),
    ]})]
  });

  const children = [
    headerTable,
    new Paragraph({ text:"" }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing:{ before:200, after:240 }, children:[ new TextRun({ text: echRapportTitre(debut, fin), bold:true, size:26, color:GREEN }) ] }),
  ];

  if(opts.analyseText && opts.analyseText.trim()){
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing:{ before:100, after:140 }, children:[ new TextRun({ text:"Analyse et interprétation", bold:true, color:GREEN }) ] }));
    opts.analyseText.trim().split(/\n+/).forEach(para=>{
      children.push(new Paragraph({ spacing:{ after:140 }, alignment: AlignmentType.JUSTIFIED, children:[ new TextRun({ text: para.trim(), size:20 }) ] }));
    });
    children.push(new Paragraph({ spacing:{ after:200 }, children:[ new TextRun({ text:"Analyse générée par intelligence artificielle — relue et validée par le responsable.", italics:true, size:15, color:"90998F" }) ] }));
  }

  if(!rows.length){
    children.push(new Paragraph({ children:[ new TextRun({ text:"Aucun échantillon prélevé enregistré pour cette période.", italics:true, color:"90998F" }) ] }));
  } else {
    const headers = ["N°","DATE DE LA VISITE","NOM DE LA STRUCTURE","ECHANTILLONS PRELEVES","DATE DE PRODUCTION","DATE DE PEREMPTION","CONCLUSION DE CONFORMITE PHYSICOCHIMIQUE","CONCLUSION DE CONFORMITE MICROBIOLOGIQUE"];
    const widths = [4,11,16,16,11,11,15.5,15.5];
    children.push(new Table({
      width:{ size:100, type:WidthType.PERCENTAGE },
      rows:[
        new TableRow({ tableHeader:true, children: headers.map((h,i)=> cell(h,{header:true, width:widths[i]})) }),
        ...rows.map((r,i)=> new TableRow({ children:[
          cell(i+1, {width:widths[0]}),
          cell(r.dateVisite?fmtDate(r.dateVisite):"—", {width:widths[1]}),
          cell(r.structure, {width:widths[2]}),
          cell(r.produit, {width:widths[3]}),
          cell(r.dateProduction?fmtDate(r.dateProduction):"—", {width:widths[4]}),
          cell(r.dateExpiration?fmtDate(r.dateExpiration):"—", {width:widths[5]}),
          cell(r.statutPhysico, {width:widths[6]}),
          cell(r.statutMicro, {width:widths[7]}),
        ]}))
      ]
    }));
  }

  if(opts.charts && rows.length){
    const nbCP = rows.filter(r=>r.statutPhysico==="Conforme").length;
    const nbNP = rows.filter(r=>r.statutPhysico==="Non conforme").length;
    const nbAP = rows.length - nbCP - nbNP;
    const nbCM = rows.filter(r=>r.statutMicro==="Conforme").length;
    const nbNM = rows.filter(r=>r.statutMicro==="Non conforme").length;
    const nbAM = rows.length - nbCM - nbNM;
    const url = makeBarChartDataUrl("Conformité des échantillons prélevés", ["Physicochimique","Microbiologique"], [
      { label:"Conforme", data:[nbCP,nbCM], color:"#1E7A3C" },
      { label:"Non conforme", data:[nbNP,nbNM], color:"#C0392B" },
      { label:"En attente", data:[nbAP,nbAM], color:"#B8791A" },
    ]);
    children.push(new Paragraph({ text:"", spacing:{ before:300 } }));
    children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:200}, children:[ new ImageRun({ data: dataUrlToUint8Array(url), transformation:{ width:480, height:255 }, type:"png" }) ] }));
  }

  children.push(new Paragraph({ spacing:{ before:400 }, children:[ new TextRun({ text:`Document généré automatiquement le ${fmtDate(todayISO())} par la plateforme SDCQN Suivi.`, italics:true, size:16, color:"90998F" }) ] }));

  const document = new Document({ sections:[{ properties:{}, children }] });
  return Packer.toBlob(document);
}

function buildEchPdfReport(rows, debut, fin, opts){
  opts = opts || {};
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"a4", orientation:"landscape" });
  const GREEN = [11,93,51];
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 40;

  doc.setFont("helvetica","bold"); doc.setFontSize(10);
  doc.text("MINISTERE DU COMMERCE ET DE L'INDUSTRIE", 40, y);
  doc.text("REPUBLIQUE DE COTE D'IVOIRE", pageWidth-40, y, { align:"right" });
  y += 13;
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text("Direction Générale du Commerce Intérieur", 40, y);
  doc.text("Union-Discipline-Travail", pageWidth-40, y, { align:"right" });
  y += 12;
  doc.text("Direction de la Métrologie, de la Répression des Fraudes et du Contrôle de la Qualité", 40, y);
  y += 12;
  doc.text("Sous-Direction du Contrôle de la Qualité et des Normes", 40, y);
  y += 26;

  doc.setFont("helvetica","bold"); doc.setFontSize(15); doc.setTextColor(...GREEN);
  doc.text(echRapportTitre(debut, fin), pageWidth/2, y, { align:"center" });
  y += 20;

  const MUTED_E = [91,107,99];
  if(opts.analyseText && opts.analyseText.trim()){
    doc.setFont("helvetica","bold"); doc.setFontSize(13); doc.setTextColor(...GREEN);
    doc.text("Analyse et interprétation", 40, y); y += 8;
    doc.setDrawColor(...GREEN); doc.setLineWidth(1); doc.line(40, y, pageWidth-40, y); y += 16;
    doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(30,30,30);
    opts.analyseText.trim().split(/\n+/).forEach(para=>{
      const lines = doc.splitTextToSize(para.trim(), pageWidth-80);
      lines.forEach(line=>{
        if(y > doc.internal.pageSize.getHeight()-40){ doc.addPage(); y = 50; }
        doc.text(line, 40, y); y += 13;
      });
      y += 6;
    });
    doc.setFont("helvetica","italic"); doc.setFontSize(8); doc.setTextColor(...MUTED_E);
    doc.text("Analyse générée par intelligence artificielle — relue et validée par le responsable.", 40, y); y += 20;
  }

  if(!rows.length){
    doc.setFont("helvetica","italic"); doc.setFontSize(10); doc.setTextColor(90,90,90);
    doc.text("Aucun échantillon prélevé enregistré pour cette période.", 40, y);
  } else {
    doc.autoTable({
      startY: y,
      head: [["N°","DATE DE LA VISITE","NOM DE LA STRUCTURE","ECHANTILLONS PRELEVES","DATE DE PRODUCTION","DATE DE PEREMPTION","CONCLUSION PHYSICOCHIMIQUE","CONCLUSION MICROBIOLOGIQUE"]],
      body: rows.map((r,i)=>[
        i+1, r.dateVisite?fmtDate(r.dateVisite):"—", r.structure, r.produit,
        r.dateProduction?fmtDate(r.dateProduction):"—", r.dateExpiration?fmtDate(r.dateExpiration):"—",
        r.statutPhysico, r.statutMicro,
      ]),
      margin:{ left:40, right:40 },
      styles:{ font:"helvetica", fontSize:8, cellPadding:4, overflow:"linebreak", valign:"top" },
      headStyles:{ fillColor:GREEN, textColor:255, fontStyle:"bold", fontSize:7.5 },
      alternateRowStyles:{ fillColor:[247,245,240] },
    });
    y = doc.lastAutoTable.finalY + 20;
  }

  if(opts.charts && rows.length){
    const nbCP = rows.filter(r=>r.statutPhysico==="Conforme").length;
    const nbNP = rows.filter(r=>r.statutPhysico==="Non conforme").length;
    const nbAP = rows.length - nbCP - nbNP;
    const nbCM = rows.filter(r=>r.statutMicro==="Conforme").length;
    const nbNM = rows.filter(r=>r.statutMicro==="Non conforme").length;
    const nbAM = rows.length - nbCM - nbNM;
    if(y > doc.internal.pageSize.getHeight()-260){ doc.addPage(); y = 50; }
    const url = makeBarChartDataUrl("Conformité des échantillons prélevés", ["Physicochimique","Microbiologique"], [
      { label:"Conforme", data:[nbCP,nbCM], color:"#1E7A3C" },
      { label:"Non conforme", data:[nbNP,nbNM], color:"#C0392B" },
      { label:"En attente", data:[nbAP,nbAM], color:"#B8791A" },
    ]);
    doc.addImage(url, "PNG", 40, y, 420, 223);
  }

  doc.setFont("helvetica","italic"); doc.setFontSize(8); doc.setTextColor(90,90,90);
  doc.text(`Document généré automatiquement le ${fmtDate(todayISO())} par la plateforme SDCQN Suivi.`, 40, doc.internal.pageSize.getHeight()-20);

  return doc;
}

document.getElementById("btnRapportEchWord").addEventListener("click", async ()=>{
  const btn = document.getElementById("btnRapportEchWord");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  try{
    const { debut, fin } = getRapportRange();
    const rows = collectEchRapportRows();
    const includeAnalyse = document.getElementById("rapportInclureAnalyseEch")?.checked ?? true;
    const analyseText = includeAnalyse ? (document.getElementById("aiAnalyseEchText")?.value || "") : "";
    const blob = await buildEchWordReport(rows, debut, fin, { charts: document.getElementById("rapportInclureHistogrammes")?.checked ?? true, analyseText });
    downloadBlob(`echantillons_preleves_${debut}_au_${fin}.docx`, blob);
    toast("Rapport des échantillons (Word) généré.");
  }catch(err){
    console.error(err);
    toast("Erreur lors de la génération du rapport des échantillons.");
  }
  btn.disabled = false; btn.textContent = original;
});

document.getElementById("btnRapportEchPdf").addEventListener("click", ()=>{
  const btn = document.getElementById("btnRapportEchPdf");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Génération en cours…";
  try{
    const { debut, fin } = getRapportRange();
    const rows = collectEchRapportRows();
    const includeAnalyse = document.getElementById("rapportInclureAnalyseEch")?.checked ?? true;
    const analyseText = includeAnalyse ? (document.getElementById("aiAnalyseEchText")?.value || "") : "";
    const doc = buildEchPdfReport(rows, debut, fin, { charts: document.getElementById("rapportInclureHistogrammes")?.checked ?? true, analyseText });
    doc.save(`echantillons_preleves_${debut}_au_${fin}.pdf`);
    toast("Rapport des échantillons (PDF) généré.");
  }catch(err){
    console.error(err);
    toast("Erreur lors de la génération du rapport des échantillons.");
  }
  btn.disabled = false; btn.textContent = original;
});

/* =========================================================================
   TABLEAU DE BORD
   ========================================================================= */

const JOURS_FR = ["Dimanche","Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi"];
const MOIS_FR_LONG = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];

function renderDashboard(){
  const missions = state.missions;
  const echantillons = state.echantillons;
  const now = new Date();
  const thisMonthKey = now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");

  loadDashFiles();

  // ---- Hero ----
  const heroDate = document.getElementById("heroDate");
  if(heroDate){
    heroDate.textContent = `${JOURS_FR[now.getDay()]} ${now.getDate()} ${MOIS_FR_LONG[now.getMonth()]} ${now.getFullYear()}`;
  }
  const heroGreeting = document.getElementById("heroGreeting");
  if(heroGreeting){
    const h = now.getHours();
    const salut = h < 12 ? "Bonjour" : (h < 18 ? "Bon après-midi" : "Bonsoir");
    heroGreeting.textContent = `${salut} — Sous-direction du Contrôle de la Qualité et des Normes`;
  }

  const elActivites = document.getElementById("dashActivites");
  if(elActivites){
    const total = state.activites.length;
    const parType = {};
    state.activites.forEach(a=>{ parType[a.type] = (parType[a.type]||0)+1; });
    const detail = Object.entries(parType).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([t,n])=>`${n} ${t.toLowerCase()}${n>1?"s":""}`).join(" · ");
    elActivites.textContent = total ? `${total} activité(s) au total${detail ? " · "+detail : ""}` : "Aucune activité enregistrée";
  }
  const elCodinorm = document.getElementById("dashCodinorm");
  if(elCodinorm){
    const total = state.reunionsCodinorm.length;
    const derniere = state.reunionsCodinorm.slice().sort((a,b)=> (b.date||"").localeCompare(a.date||""))[0];
    elCodinorm.textContent = total ? `${total} réunion(s)${derniere ? " · dernière le "+fmtDate(derniere.date) : ""}` : "Aucune réunion enregistrée";
  }

  // ---- Activités à venir (rappels) — bannière défilante ----
  const dashRappelsCountEl = document.getElementById("dashRappelsCount");
  const tickerEl = document.getElementById("dashTickerContent");
  if(dashRappelsCountEl){
    const upcoming = state.rappels.filter(r=> r.statut==="À venir");
    dashRappelsCountEl.textContent = upcoming.length;
    if(tickerEl){
      if(!upcoming.length){
        tickerEl.innerHTML = "Aucune activité à venir enregistrée.";
        tickerEl.style.animation = "none";
      } else {
        const sorted = upcoming.slice().sort((a,b)=> (a.date||"").localeCompare(b.date||""));
        const items = sorted.map(r=>{
          const u = rappelUrgency(r);
          const dl = daysUntil(r.date);
          const when = u==="overdue" ? "en retard" : u==="today" ? "aujourd'hui" : `dans ${dl} j.`;
          return `<span>${u==="overdue"||u==="today"?"⚠ ":""}${escapeHtml(r.titre)} — ${escapeHtml(r.type)} (${when})</span>`;
        }).join("");
        tickerEl.innerHTML = items;
        tickerEl.style.animation = "";
      }
    }
  }

  const missionGroups = groupMissionsList(missions);
  document.getElementById("kpiMissions").textContent = missionGroups.length;

  const totalEntreprisesVisitees = missionGroups.reduce((sum,g)=> sum + groupNbEntreprises(g), 0);
  document.getElementById("kpiEntreprises").textContent = totalEntreprisesVisitees;

  const totalEchantillonsPreleves = missionGroups.reduce((sum,g)=> sum + groupNbEchantillons(g), 0);
  document.getElementById("kpiEchantillons").textContent = totalEchantillonsPreleves;
  const enAttente = echantillons.filter(e=> e.statut === "En attente" || !e.statut).length;
  document.getElementById("kpiEchantillonsSub").textContent = `${enAttente} en attente de résultats`;

  const analyses = echantillons.filter(e=> e.statut === "Conforme" || e.statut === "Non conforme");
  const conformes = analyses.filter(e=> e.statut === "Conforme").length;
  const tauxEl = document.getElementById("kpiConformite");
  const tauxSub = document.getElementById("kpiConformiteSub");
  if(analyses.length){
    const taux = Math.round((conformes/analyses.length)*100);
    tauxEl.textContent = taux + "%";
    tauxEl.style.color = taux >= 80 ? "var(--success)" : (taux >= 50 ? "var(--warn)" : "var(--danger)");
    tauxSub.textContent = `${conformes} conformes sur ${analyses.length} analysés`;
  } else {
    tauxEl.textContent = "—"; tauxEl.style.color = "var(--forest-dark)";
    tauxSub.textContent = "Aucun résultat d'analyse enregistré";
  }

}

/* =========================================================================
   SYNCHRONISATION RÉSEAU — serveur central optionnel
   ========================================================================= */

const SYNC_CFG_KEY = "sdcqn_sync_cfg";
let syncCfg = { enabled: false, url: "", key: "" };
let syncUnlocked = false; // déverrouillage temporaire (pour cette session) des champs de synchronisation
try{
  const nativeSaved = nativeLoadSettings();
  if(nativeSaved && nativeSaved.syncCfg){
    syncCfg = Object.assign(syncCfg, nativeSaved.syncCfg);
  } else {
    const raw = localStorage.getItem(SYNC_CFG_KEY);
    if(raw) syncCfg = Object.assign(syncCfg, JSON.parse(raw));
  }
}catch(e){}

let syncStatus = "local"; // local | syncing | synced | error
let syncErrorMsg = "";
let syncPushTimer = null;
let syncPollTimer = null;
let lastKnownServerUpdatedAt = null;

// Suivi des modifications locales pas encore envoyées au serveur (ex : saisies faites
// hors connexion). Tant que ce indicateur est actif, l'application privilégie l'envoi
// de ces modifications plutôt que de récupérer (et potentiellement écraser localement)
// les données du serveur, pour ne jamais perdre une saisie faite hors connexion.
const PENDING_PUSH_KEY = "sdcqn_pending_push";
let pendingPush = localStorage.getItem(PENDING_PUSH_KEY) === "1";
function markPendingPush(pending){
  pendingPush = pending;
  if(pending) localStorage.setItem(PENDING_PUSH_KEY, "1");
  else localStorage.removeItem(PENDING_PUSH_KEY);
  updateSyncUI();
}

function saveSyncCfg(){
  localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(syncCfg));
  nativeSaveSettings({ syncCfg });
  androidSaveSettingsAsync({ syncCfg });
}

function normalizeServerUrl(u){
  return (u||"").trim().replace(/\/+$/,"");
}

function setSyncStatus(s, msg){
  syncStatus = s; syncErrorMsg = msg||"";
  updateSyncUI();
}

function updateSyncUI(){
  const labelMap = {
    local:   { text:"Local uniquement", cls:"is-local" },
    syncing: { text:"Synchronisation…", cls:"is-syncing" },
    synced:  { text:"Synchronisé", cls:"is-synced" },
    error:   { text:"Serveur injoignable", cls:"is-error" },
    pending: { text:"En attente d'envoi", cls:"is-syncing" },
  };
  const effectiveStatus = (pendingPush && syncCfg.enabled) ? "pending" : syncStatus;
  const info = labelMap[effectiveStatus] || labelMap.local;
  [["syncPill","syncDot","syncLabel"], ["syncPillSettings","syncDotSettings","syncLabelSettings"]].forEach(([pillId,dotId,labelId])=>{
    const pill = document.getElementById(pillId);
    const label = document.getElementById(labelId);
    if(!pill) return;
    pill.classList.remove("is-local","is-syncing","is-synced","is-error");
    pill.classList.add(info.cls);
    if(label) label.textContent = info.text;
  });
  const detail = document.getElementById("syncStatusDetail");
  if(detail){
    if(!syncCfg.url) detail.textContent = "Aucun serveur configuré : les données restent enregistrées uniquement sur cet ordinateur.";
    else if(pendingPush && syncCfg.enabled) detail.textContent = `Des saisies faites sur ce poste n'ont pas encore été envoyées à ${syncCfg.url} (connexion indisponible). Elles resteront en attente et seront envoyées automatiquement dès que le serveur sera de nouveau joignable — rien n'est perdu.`;
    else if(syncStatus==="error") detail.textContent = `Impossible de joindre ${syncCfg.url}. Les données restent enregistrées localement en attendant. (${escapeHtml(syncErrorMsg)})`;
    else if(syncStatus==="syncing") detail.textContent = isGasBackend(syncCfg.url) ? "Connexion à l'espace Google en cours — cela peut prendre jusqu'à 30 secondes s'il n'a pas été utilisé récemment, le temps que Google réactive le service. Vous pouvez continuer à utiliser l'application normalement pendant ce temps." : `Connexion à ${syncCfg.url} en cours…`;
    else if(syncCfg.enabled) detail.textContent = `Synchronisation active avec ${syncCfg.url}.`;
    else detail.textContent = `Serveur renseigné (${syncCfg.url}) mais synchronisation désactivée.`;
  }
  const toggleBtn = document.getElementById("btnToggleSync");
  if(toggleBtn) toggleBtn.textContent = syncCfg.enabled ? "Désactiver la synchronisation" : "Activer la synchronisation";
  const urlInput = document.getElementById("syncUrlInput");
  if(urlInput && document.activeElement !== urlInput) urlInput.value = syncCfg.url;
  const keyInput = document.getElementById("syncKeyInput");
  if(keyInput && document.activeElement !== keyInput) keyInput.value = syncCfg.key || "";

  // Verrouillage : une fois la synchronisation activée, l'adresse et la clé sont figées
  // pour ce poste, afin d'éviter toute modification accidentelle par un autre utilisateur.
  const lockNote = document.getElementById("syncLockNote");
  const unlockBtn = document.getElementById("btnUnlockSync");
  const locked = syncCfg.enabled && !syncUnlocked;
  if(urlInput) urlInput.disabled = locked;
  if(keyInput) keyInput.disabled = locked;
  if(lockNote) lockNote.hidden = !locked;
  if(unlockBtn) unlockBtn.hidden = !(syncCfg.enabled && !syncUnlocked);
  if(toggleBtn) toggleBtn.hidden = locked;
}

// Un espace Google (Apps Script) utilise une seule adresse avec une action en
// paramètre, plutôt que des routes /api/... classiques avec verbes HTTP et
// en-têtes personnalisés (non gérés proprement par Apps Script). On détecte
// ce cas à partir de l'adresse et on adapte le format des requêtes en
// conséquence, de façon transparente pour le reste de l'application.
function isGasBackend(url){
  return /script\.google(?:usercontent)?\.com/i.test(url||"");
}
const GAS_ACTION_MAP = { "/api/state": "state", "/api/state/meta": "stateMeta", "/api/ai/status": "aiStatus", "/api/files": "listFiles" };

async function apiGet(path){
  const base = normalizeServerUrl(syncCfg.url);
  if(isGasBackend(base)){
    const action = GAS_ACTION_MAP[path] || path.replace(/^\/+/,"");
    const url = base + "?action=" + encodeURIComponent(action) + "&key=" + encodeURIComponent(syncCfg.key||"");
    const res = await fetch(url);
    if(!res.ok) throw new Error("HTTP "+res.status);
    const data = await res.json();
    if(data && data.error) throw new Error(data.error);
    return data;
  }
  const url = base + path;
  const res = await fetch(url, { headers:{ "Accept":"application/json", "X-SDCQN-Key": syncCfg.key || "" } });
  if(res.status === 401) throw new Error("Clé d'accès invalide ou manquante");
  if(!res.ok) throw new Error("HTTP "+res.status);
  return res.json();
}
async function apiPut(path, body){
  const base = normalizeServerUrl(syncCfg.url);
  if(isGasBackend(base)){
    // Content-Type "text/plain" volontairement : évite le préflight CORS
    // qu'Apps Script ne gère pas ; le contenu envoyé reste du JSON valide.
    const res = await fetch(base, {
      method:"POST",
      headers:{ "Content-Type":"text/plain;charset=utf-8" },
      body: JSON.stringify({ action:"putState", key: syncCfg.key||"", payload: body }),
    });
    if(!res.ok) throw new Error("HTTP "+res.status);
    const data = await res.json();
    if(data && data.error) throw new Error(data.error);
    return data;
  }
  const url = base + path;
  const res = await fetch(url, {
    method:"PUT",
    headers:{ "Content-Type":"application/json", "X-SDCQN-Key": syncCfg.key || "" },
    body: JSON.stringify(body),
  });
  if(res.status === 401) throw new Error("Clé d'accès invalide ou manquante");
  if(!res.ok) throw new Error("HTTP "+res.status);
  return res.json();
}

async function apiPostFile(payload){
  const base = normalizeServerUrl(syncCfg.url);
  if(isGasBackend(base)){
    const res = await fetch(base, {
      method:"POST",
      headers:{ "Content-Type":"text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ action:"uploadFile", key: syncCfg.key||"" }, payload)),
    });
    if(!res.ok) throw new Error("HTTP "+res.status);
    const data = await res.json();
    if(data && data.error) throw new Error(data.error);
    return data;
  }
  const url = base + "/api/files";
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "X-SDCQN-Key": syncCfg.key || "" },
    body: JSON.stringify(payload),
  });
  if(res.status === 401) throw new Error("Clé d'accès invalide ou manquante");
  if(!res.ok) throw new Error("HTTP "+res.status);
  return res.json();
}
async function apiDeleteFile(id){
  const base = normalizeServerUrl(syncCfg.url);
  if(isGasBackend(base)){
    const res = await fetch(base, {
      method:"POST",
      headers:{ "Content-Type":"text/plain;charset=utf-8" },
      body: JSON.stringify({ action:"deleteFile", key: syncCfg.key||"", id }),
    });
    if(!res.ok) throw new Error("HTTP "+res.status);
    return res.json();
  }
  const url = base + "/api/files/" + id;
  const res = await fetch(url, { method:"DELETE", headers:{ "X-SDCQN-Key": syncCfg.key || "" } });
  if(!res.ok) throw new Error("HTTP "+res.status);
  return res.json();
}
async function downloadAttachment(id, name){
  try{
    const base = normalizeServerUrl(syncCfg.url);
    if(isGasBackend(base)){
      const url = base + "?action=downloadFile&id=" + encodeURIComponent(id) + "&key=" + encodeURIComponent(syncCfg.key||"");
      const res = await fetch(url);
      if(!res.ok) throw new Error("HTTP "+res.status);
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      const byteChars = atob(data.dataBase64);
      const bytes = new Uint8Array(byteChars.length);
      for(let i=0;i<byteChars.length;i++) bytes[i] = byteChars.charCodeAt(i);
      downloadBlob(name, new Blob([bytes], { type: data.mimeType||"application/octet-stream" }));
      return;
    }
    const url = base + "/api/files/" + id;
    const res = await fetch(url, { headers:{ "X-SDCQN-Key": syncCfg.key || "" } });
    if(res.status === 401){ toast("Clé d'accès invalide."); return; }
    if(!res.ok) throw new Error("HTTP "+res.status);
    const blob = await res.blob();
    downloadBlob(name, blob);
  }catch(err){
    toast("Téléchargement impossible (serveur injoignable ?).");
  }
}

function scheduleSyncPush(){
  if(!syncCfg.enabled || !syncCfg.url) return;
  markPendingPush(true);
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(pushStateToServer, 700);
}

async function pushStateToServer(){
  if(!syncCfg.enabled || !syncCfg.url) return;
  setSyncStatus("syncing");
  try{
    const payload = { missions: state.missions, echantillons: state.echantillons, activites: state.activites, secteurs: state.secteurs, responsables: state.responsables, reunionsCodinorm: state.reunionsCodinorm, rappels: state.rappels, entreprises: state.entreprises, commissions: state.commissions, archives: state.archives, dossiers: state.dossiers };
    const res = await apiPut("/api/state", payload);
    lastKnownServerUpdatedAt = res.updatedAt || Date.now();
    markPendingPush(false);
    setSyncStatus("synced");
  }catch(err){
    // Le serveur est injoignable ou une erreur est survenue : on conserve l'indicateur
    // "en attente" pour réessayer automatiquement d'envoyer ces modifications dès que
    // la connexion au serveur sera rétablie (voir startSyncPolling).
    setSyncStatus("error", err.message);
  }
}

async function pullStateFromServer(showToastOnChange){
  if(!syncCfg.enabled || !syncCfg.url) return;
  // Des modifications locales sont en attente d'envoi : on les pousse d'abord, pour ne
  // jamais écraser une saisie locale non encore synchronisée avec une version plus
  // ancienne récupérée depuis le serveur.
  if(pendingPush){ await pushStateToServer(); if(pendingPush) return; }
  try{
    // Vérification légère (quelques octets) avant de télécharger toutes les données :
    // économise la bande passante, surtout utile pour une synchronisation via Internet.
    const meta = await apiGet("/api/state/meta");
    if(meta && meta.updatedAt === lastKnownServerUpdatedAt){
      setSyncStatus("synced");
      return;
    }
    const remote = await apiGet("/api/state");
    if(remote && remote.updatedAt !== lastKnownServerUpdatedAt){
      lastKnownServerUpdatedAt = remote.updatedAt;
      state.missions = remote.missions || [];
      state.echantillons = remote.echantillons || [];
      state.activites = remote.activites || [];
      state.secteurs = (remote.secteurs && remote.secteurs.length) ? remote.secteurs : DEFAULT_SECTEURS.slice();
      state.responsables = remote.responsables || [];
      state.reunionsCodinorm = remote.reunionsCodinorm || [];
      state.rappels = remote.rappels || [];
      state.entreprises = remote.entreprises || [];
      state.commissions = remote.commissions || {};
      state.archives = remote.archives || state.archives || [];
      state.dossiers = remote.dossiers || {};
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      setSyncStatus("synced");
      updateBellUI();
      checkRappelNotifications();
      // Ne pas interrompre une saisie en cours : on rafraîchit seulement si aucun formulaire n'est ouvert
      if(overlay.hidden){
        const current = document.querySelector(".nav-item.active")?.dataset.view || "dashboard";
        goView(current);
        if(showToastOnChange) toast("Données mises à jour depuis le serveur.");
      }
    } else {
      setSyncStatus("synced");
    }
  }catch(err){
    setSyncStatus("error", err.message);
  }
}

let syncRequestInFlight = false;
function startSyncPolling(){
  clearInterval(syncPollTimer);
  if(!syncCfg.enabled || !syncCfg.url) return;
  syncPollTimer = setInterval(async ()=>{
    // Ne jamais superposer deux requêtes de synchronisation : avec un serveur plus lent à
    // répondre (espace Google notamment), cela provoquait des requêtes concurrentes qui se
    // gênaient mutuellement et rendaient la connexion instable.
    if(syncRequestInFlight) return;
    syncRequestInFlight = true;
    try{
      if(pendingPush) await pushStateToServer();
      else await pullStateFromServer(true);
    } finally {
      syncRequestInFlight = false;
    }
  }, 4000);
}

async function testSyncConnection(url, key){
  const clean = normalizeServerUrl(url);
  if(!clean){ toast("Veuillez saisir l'adresse du serveur."); return false; }
  try{
    if(isGasBackend(clean)){
      const pingRes = await fetch(clean + "?action=health");
      if(!pingRes.ok) throw new Error("HTTP "+pingRes.status);
      const stateRes = await fetch(clean + "?action=state&key=" + encodeURIComponent(key||""));
      if(!stateRes.ok) throw new Error("HTTP "+stateRes.status);
      const data = await stateRes.json();
      if(data && data.error){ toast("Espace Google joignable, mais clé d'accès incorrecte."); return false; }
      toast("Connexion réussie — espace Google joignable et clé d'accès valide.");
      return true;
    }
    const pingRes = await fetch(clean + "/api/health");
    if(!pingRes.ok) throw new Error("HTTP "+pingRes.status);
    const stateRes = await fetch(clean + "/api/state", { headers:{ "X-SDCQN-Key": key || "" } });
    if(stateRes.status === 401){ toast("Serveur joignable, mais clé d'accès incorrecte."); return false; }
    if(!stateRes.ok) throw new Error("HTTP "+stateRes.status);
    toast("Connexion réussie — serveur joignable et clé d'accès valide.");
    return true;
  }catch(err){
    toast("Connexion impossible : vérifiez l'adresse et le réseau.");
    return false;
  }
}

document.getElementById("btnTestSync")?.addEventListener("click", ()=>{
  const url = document.getElementById("syncUrlInput").value;
  const key = document.getElementById("syncKeyInput").value.trim();
  testSyncConnection(url, key);
});

document.getElementById("btnToggleSync")?.addEventListener("click", async ()=>{
  const urlInput = document.getElementById("syncUrlInput");
  const keyInput = document.getElementById("syncKeyInput");
  const url = normalizeServerUrl(urlInput.value);
  const key = keyInput.value.trim();
  if(!syncCfg.enabled){
    if(!url){ toast("Veuillez saisir l'adresse du serveur avant d'activer la synchronisation."); return; }
    if(!key){ toast("Veuillez saisir la clé d'accès du serveur avant d'activer la synchronisation."); return; }
    const ok = await testSyncConnection(url, key);
    if(!ok) return;
    if(!await appConfirm("Activer la synchronisation remplacera les données locales de cet ordinateur par celles du serveur central (si celui-ci contient déjà des données). Continuer ?")){ return; }
    syncCfg = { enabled:true, url, key };
    saveSyncCfg();
    setSyncStatus("syncing");
    try{
      const remote = await apiGet("/api/state");
      if(remote){
        lastKnownServerUpdatedAt = remote.updatedAt;
        state.missions = remote.missions || [];
        state.echantillons = remote.echantillons || [];
        state.activites = remote.activites || [];
        state.secteurs = (remote.secteurs && remote.secteurs.length) ? remote.secteurs : DEFAULT_SECTEURS.slice();
        state.responsables = remote.responsables || [];
        state.reunionsCodinorm = remote.reunionsCodinorm || [];
        state.rappels = remote.rappels || [];
        state.entreprises = remote.entreprises || [];
        state.commissions = remote.commissions && Object.keys(remote.commissions).length ? remote.commissions : state.commissions;
        state.dossiers = remote.dossiers && Object.keys(remote.dossiers).length ? remote.dossiers : state.dossiers;
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
      } else {
        await pushStateToServer();
      }
      setSyncStatus("synced");
      toast("Synchronisation activée.");
    }catch(err){
      setSyncStatus("error", err.message);
    }
    startSyncPolling();
    goView(document.querySelector(".nav-item.active")?.dataset.view || "dashboard");
  } else {
    syncCfg.enabled = false;
    saveSyncCfg();
    clearInterval(syncPollTimer);
    setSyncStatus("local");
    toast("Synchronisation désactivée. Les données restent en local.");
  }
  updateSyncUI();
});

document.getElementById("btnUnlockSync")?.addEventListener("click", async ()=>{
  if(!await appConfirm("Modifier l'adresse ou la clé d'accès peut interrompre la synchronisation avec les autres postes si les valeurs ne correspondent plus au même serveur. Continuer ?")) return;
  syncUnlocked = true;
  updateSyncUI();
  toast("Configuration déverrouillée pour modification.");
});

// Initialisation de la synchronisation au démarrage
(function initSync(){
  updateSyncUI();
  if(syncCfg.enabled && syncCfg.url){
    setSyncStatus("syncing");
    // Si des saisies faites hors connexion attendent d'être envoyées (session précédente
    // fermée sans connexion au serveur), on les pousse avant toute récupération.
    const startupTask = pendingPush ? pushStateToServer() : Promise.resolve();
    startupTask.then(()=> pullStateFromServer(false)).then(()=> startSyncPolling());
  }
})();

/* =========================================================================
   PWA — installation
   ========================================================================= */

let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e)=>{
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById("installBanner").classList.add("show");
});
document.getElementById("btnInstall").addEventListener("click", async ()=>{
  if(!deferredPrompt) { toast("Utilisez le menu de votre navigateur : « Installer l'application »."); return; }
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  document.getElementById("installBanner").classList.remove("show");
});
window.addEventListener("appinstalled", ()=>{
  document.getElementById("installBanner").classList.remove("show");
  toast("Application installée avec succès.");
});

if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  });
}

/* --------------------------- Init --------------------------- */
goView("dashboard");
androidRestoreSettingsAsync();
