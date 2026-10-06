// ============================================================
// Stock – interface (affichage et événements)
// ============================================================

import { auth } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import * as donnees from "./stock-data.js";

const PARTIES = {
  epi: "EPI",
  materiel: "Matériel & produits"
};

const VUES = ["global", "mouvement", "historique", "articles", "parametres"];

const etat = {
  profil: null,
  partie: "epi",
  vue: "global",
  familles: [],
  articles: [],
  beneficiaires: [],
  mouvements: [],
  demarre: false,
  ecoutes: [],
  stopMouvements: null,
  benefEnAttente: null
};

// ============================================================
// Utilitaires
// ============================================================

const $ = (sel, racine = document) => racine.querySelector(sel);
const $$ = (sel, racine = document) => [...racine.querySelectorAll(sel)];

function esc(valeur) {
  return String(valeur ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function isoJour(d) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function decalerJours(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function formatDate(valeur) {
  const d = valeur?.toDate ? valeur.toDate() : valeur;
  return d instanceof Date ? d.toLocaleDateString("fr-FR") : "";
}

function nb(n) {
  return Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
}

function triFr(a, b) {
  return String(a).localeCompare(String(b), "fr", { sensitivity: "base" });
}

// ok / alerte (stock ≤ seuil) / rupture (stock ≤ 0)
function niveau(article) {
  const stock = article.stock || 0;
  if (stock <= 0) return "rupture";
  if (stock <= (article.seuilAlerte || 0)) return "alerte";
  return "ok";
}

// Quantité pour revenir au stock cible, uniquement si l'article est sous le seuil.
function aCommander(article) {
  const cible = article.stockCible || 0;
  if (!cible || niveau(article) === "ok") return 0;
  return Math.max(Math.round((cible - (article.stock || 0)) * 100) / 100, 0);
}

function articlesPartie({ archives = false } = {}) {
  return etat.articles.filter((a) => a.partie === etat.partie && (archives || a.actif !== false));
}

function famillesPartie() {
  return etat.familles
    .filter((f) => f.partie === etat.partie)
    .sort((a, b) => triFr(a.nom, b.nom));
}

function nomFamille(id) {
  return etat.familles.find((f) => f.id === id)?.nom || "Sans famille";
}

function grouperParFamille(articles) {
  const groupes = new Map();
  for (const f of famillesPartie()) {
    groupes.set(f.id, { nom: f.nom, articles: [] });
  }
  for (const a of articles) {
    if (!groupes.has(a.familleId)) {
      groupes.set(a.familleId, { nom: "Sans famille", articles: [] });
    }
    groupes.get(a.familleId).articles.push(a);
  }
  return [...groupes.values()]
    .filter((g) => g.articles.length)
    .map((g) => ({ ...g, articles: g.articles.sort((x, y) => triFr(x.designation, y.designation)) }));
}

// Remplace les options d'un select en conservant la sélection si elle existe encore.
function remplirSelect(select, html) {
  const valeur = select.value;
  select.innerHTML = html;
  if ([...select.options].some((o) => o.value === valeur)) {
    select.value = valeur;
  }
}

function optionsArticles(articles, libelleVide) {
  const groupes = grouperParFamille(articles).map((g) => `
    <optgroup label="${esc(g.nom)}">
      ${g.articles.map((a) => `
        <option value="${a.id}">${esc(a.designation)} (${esc(a.reference)})${a.actif === false ? " – archivé" : ""}</option>
      `).join("")}
    </optgroup>`).join("");
  return `<option value="">${libelleVide}</option>${groupes}`;
}

function optionsBeneficiaires(libelleVide) {
  const groupe = (type, label) => {
    const liste = etat.beneficiaires
      .filter((b) => b.type === type)
      .sort((a, b) => triFr(a.libelle, b.libelle));
    if (!liste.length) return "";
    return `<optgroup label="${label}">${liste.map((b) => `<option value="${b.id}">${esc(b.libelle)}</option>`).join("")}</optgroup>`;
  };
  return `<option value="">${libelleVide}</option>${groupe("agent", "Agents")}${groupe("service", "Services")}`;
}

let minuteurToast;
function toast(message, type = "ok") {
  const t = $("#toast");
  t.textContent = message;
  t.dataset.type = type;
  t.classList.add("visible");
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => t.classList.remove("visible"), 4500);
}

function erreurLecture(err) {
  console.error(err);
  toast(`Lecture impossible : ${err.message}`, "erreur");
}

// ============================================================
// Démarrage / authentification
// ============================================================

onAuthStateChanged(auth, async (user) => {
  $("#ecran-refus").hidden = true;

  if (!user) {
    arreter();
    $("#app").hidden = true;
    $("#ecran-connexion").hidden = false;
    return;
  }

  $("#ecran-connexion").hidden = true;

  let profil = null;
  try {
    profil = await donnees.lireProfil(user.email);
  } catch (err) {
    console.error(err);
  }

  if (!profil) {
    $("#app").hidden = true;
    $("#ecran-refus").hidden = false;
    return;
  }

  appliquerProfil(profil);
  $("#app").hidden = false;
  demarrer();
});

// Rôle "admin" : tout. Rôle "lecture" : onglets et parties listés, sans aucune action.
function appliquerProfil(profil) {
  const admin = profil.role === "admin";
  const toutesParties = Object.keys(PARTIES);

  let parties = Array.isArray(profil.parties) ? profil.parties.filter((p) => p in PARTIES) : [];
  if (admin || !parties.length) parties = toutesParties;

  let vues = Array.isArray(profil.onglets) ? profil.onglets : ["global", "historique"];
  vues = admin ? VUES : vues.filter((v) => VUES.includes(v) && v !== "mouvement");
  if (!vues.length) vues = ["global"];

  etat.profil = { admin, parties, vues };
  document.body.classList.toggle("lecture-seule", !admin);
  $("#mode-lecture").hidden = admin;

  $$(".bascule-partie button").forEach((b) => { b.hidden = !parties.includes(b.dataset.partie); });
  $$(".onglets button").forEach((b) => { b.hidden = !vues.includes(b.dataset.vue); });

  if (!parties.includes(etat.partie)) etat.partie = parties[0];
  if (!vues.includes(etat.vue)) etat.vue = vues[0];
}

function demarrer() {
  if (etat.demarre) return;
  etat.demarre = true;
  etat.ecoutes = [
    donnees.ecouterFamilles((l) => { etat.familles = l; rendre(); }, erreurLecture),
    donnees.ecouterArticles((l) => { etat.articles = l; rendre(); }, erreurLecture),
    donnees.ecouterBeneficiaires((l) => { etat.beneficiaires = l; rendre(); }, erreurLecture)
  ];
  changerPartie(etat.partie);
  changerVue(etat.vue);
}

function arreter() {
  etat.ecoutes.forEach((stop) => stop());
  etat.stopMouvements?.();
  etat.ecoutes = [];
  etat.stopMouvements = null;
  etat.demarre = false;
  etat.profil = null;
  document.body.classList.remove("lecture-seule");
  etat.familles = [];
  etat.articles = [];
  etat.beneficiaires = [];
  etat.mouvements = [];
}

function abonnerMouvements() {
  if (!etat.demarre) return;
  etat.stopMouvements?.();
  etat.mouvements = [];

  const du = $("#hist-du").value;
  const au = $("#hist-au").value;
  if (!du || !au || du > au) {
    toast("Période invalide : la date de début doit précéder la date de fin.", "erreur");
    return;
  }

  etat.stopMouvements = donnees.ecouterMouvements(
    etat.partie,
    new Date(`${du}T00:00:00`),
    new Date(`${au}T23:59:59`),
    (liste) => {
      etat.mouvements = liste;
      if (etat.vue === "historique") rendreHistorique();
    },
    erreurLecture
  );
}

$("#form-connexion").addEventListener("submit", async (e) => {
  e.preventDefault();
  const erreur = $("#cx-erreur");
  erreur.hidden = true;
  try {
    await signInWithEmailAndPassword(auth, $("#cx-email").value.trim(), $("#cx-mdp").value);
  } catch (err) {
    erreur.textContent = err.code === "auth/invalid-credential"
      ? "Adresse e-mail ou mot de passe incorrect."
      : `Connexion impossible : ${err.message}`;
    erreur.hidden = false;
  }
});

$("#btn-deconnexion").addEventListener("click", () => signOut(auth));
$("#btn-refus-deconnexion").addEventListener("click", () => signOut(auth));

// ============================================================
// Navigation
// ============================================================

function changerPartie(partie) {
  if (etat.profil && !etat.profil.parties.includes(partie)) return;
  etat.partie = partie;
  document.body.dataset.partie = partie;
  $$(".bascule-partie button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.partie === partie));
  });
  $("#hist-article").value = "";
  abonnerMouvements();
  rendre();
}

function changerVue(vue) {
  if (etat.profil && !etat.profil.vues.includes(vue)) return;
  etat.vue = vue;
  $$(".vue").forEach((s) => { s.hidden = s.id !== `vue-${vue}`; });
  $$(".onglets button").forEach((b) => {
    if (b.dataset.vue === vue) {
      b.setAttribute("aria-current", "page");
    } else {
      b.removeAttribute("aria-current");
    }
  });
  rendre();
}

$$(".bascule-partie button").forEach((b) => b.addEventListener("click", () => changerPartie(b.dataset.partie)));
$$(".onglets button").forEach((b) => b.addEventListener("click", () => changerVue(b.dataset.vue)));

function rendre() {
  if (!etat.demarre) return;
  rendreBadges();
  const vues = {
    global: rendreGlobal,
    mouvement: rendreMouvement,
    historique: rendreHistorique,
    articles: rendreArticles,
    parametres: rendreParametres
  };
  vues[etat.vue]();
}

function rendreBadges() {
  for (const p of etat.profil.parties) {
    const n = etat.articles.filter((a) => a.partie === p && a.actif !== false && niveau(a) !== "ok").length;
    const badge = $(`#badge-${p}`);
    badge.textContent = n;
    badge.hidden = n === 0;
    badge.title = `${n} article(s) sous le seuil d'alerte`;
  }
}

// ============================================================
// Vue globale
// ============================================================

function rendreGlobal() {
  const recherche = $("#global-recherche").value.trim().toLowerCase();
  const alertesSeules = $("#global-alertes").checked;
  const articles = articlesPartie();
  const nbAlerte = articles.filter((a) => niveau(a) === "alerte").length;
  const nbRupture = articles.filter((a) => niveau(a) === "rupture").length;

  $("#global-resume").innerHTML = `
    <div class="stat"><strong>${articles.length}</strong><span>références</span></div>
    <div class="stat stat-alerte"><strong>${nbAlerte}</strong><span>sous le seuil</span></div>
    <div class="stat stat-rupture"><strong>${nbRupture}</strong><span>en rupture</span></div>`;

  if (!articles.length) {
    $("#global-liste").innerHTML = `
      <div class="vide-bloc">
        <p>Aucun article en ${esc(PARTIES[etat.partie])} pour l'instant.</p>
        <button type="button" class="btn btn-principal" data-aller="articles" data-ecriture>Créer un article</button>
      </div>`;
    return;
  }

  const filtres = articles.filter((a) =>
    (!alertesSeules || niveau(a) !== "ok") &&
    (!recherche || `${a.designation} ${a.reference}`.toLowerCase().includes(recherche))
  );

  if (!filtres.length) {
    $("#global-liste").innerHTML = `<p class="vide">${alertesSeules ? "Aucun article sous le seuil. Tout est en ordre." : "Aucun article ne correspond à la recherche."}</p>`;
    return;
  }

  $("#global-liste").innerHTML = grouperParFamille(filtres).map((g) => `
    <section class="groupe">
      <h2>${esc(g.nom)} <span class="groupe-compte">${g.articles.length}</span></h2>
      <ul class="liste-stock">
        ${g.articles.map(ligneStock).join("")}
      </ul>
    </section>`).join("");
}

function ligneStock(a) {
  const stock = Math.max(a.stock || 0, 0);
  const seuil = a.seuilAlerte || 0;
  const cible = a.stockCible || 0;
  const max = cible > 0 ? Math.max(cible, stock) : Math.max(seuil * 3, stock, 1);
  const commande = aCommander(a);
  const pct = Math.min((stock / max) * 100, 100);
  const seuilPct = Math.min((seuil / max) * 100, 100);
  const niv = niveau(a);
  const etiquette = { ok: "", alerte: "Sous le seuil", rupture: "Rupture" }[niv];

  return `
    <li class="ligne-stock niveau-${niv}">
      <div class="ligne-info">
        <span class="ligne-nom">${esc(a.designation)}</span>
        <span class="ligne-ref">${esc(a.reference)}${etiquette ? ` <em class="etiquette">${etiquette}</em>` : ""}</span>
      </div>
      <div class="ligne-jauge" aria-hidden="true">
        <span style="width: ${pct}%"></span>
        ${seuil > 0 ? `<i style="left: ${seuilPct}%"></i>` : ""}
      </div>
      <div class="ligne-qte">
        <strong>${nb(a.stock)}</strong> ${esc(a.unite)}
        <small>seuil ${nb(seuil)}${cible > 0 ? `, cible ${nb(cible)}` : ""}</small>
        ${commande > 0 ? `<small class="a-commander">À commander : ${nb(commande)}</small>` : ""}
      </div>
      <div class="ligne-actions" data-ecriture>
        <button type="button" class="btn btn-secondaire btn-petit" data-action="sortie" data-id="${a.id}">Sortie</button>
        <button type="button" class="btn btn-secondaire btn-petit" data-action="entree" data-id="${a.id}">Entrée</button>
      </div>
    </li>`;
}

$("#global-recherche").addEventListener("input", rendreGlobal);
$("#global-alertes").addEventListener("change", rendreGlobal);

$("#global-liste").addEventListener("click", (e) => {
  const bouton = e.target.closest("button");
  if (!bouton) return;
  if (bouton.dataset.aller) {
    changerVue(bouton.dataset.aller);
    return;
  }
  if (bouton.dataset.action) {
    ouvrirMouvement(bouton.dataset.action, bouton.dataset.id);
  }
});

// ============================================================
// Entrée / sortie
// ============================================================

function typeMouvement() {
  return $('input[name="mvt-type"]:checked').value;
}

function ouvrirMouvement(type, articleId) {
  $(`input[name="mvt-type"][value="${type}"]`).checked = true;
  changerVue("mouvement");
  const article = etat.articles.find((a) => a.id === articleId);
  $("#mvt-famille").value = article?.familleId || "";
  rendreMouvement();
  $("#mvt-article").value = articleId;
  majInfosMouvement();
  $("#mvt-quantite").focus();
}

function rendreMouvement() {
  const optionsFamilles = famillesPartie()
    .map((f) => `<option value="${f.id}">${esc(f.nom)}</option>`)
    .join("");
  remplirSelect($("#mvt-famille"), `<option value="">Toutes les familles</option>${optionsFamilles}`);

  const familleId = $("#mvt-famille").value;
  const articles = articlesPartie().filter((a) => !familleId || a.familleId === familleId);
  remplirSelect($("#mvt-article"), optionsArticles(articles, "Choisir un article"));
  remplirSelect($("#mvt-beneficiaire"), optionsBeneficiaires("Choisir un agent ou un service"));
  if (etat.benefEnAttente && etat.beneficiaires.some((b) => b.id === etat.benefEnAttente)) {
    $("#mvt-beneficiaire").value = etat.benefEnAttente;
    etat.benefEnAttente = null;
  }
  majInfosMouvement();
}

function majInfosMouvement() {
  const sortie = typeMouvement() === "sortie";
  $("#bloc-beneficiaire").hidden = !sortie;
  $("#mvt-beneficiaire").required = sortie;
  $("#mvt-valider").textContent = sortie ? "Enregistrer la sortie" : "Enregistrer l'entrée";

  const info = $("#mvt-info");
  const article = etat.articles.find((a) => a.id === $("#mvt-article").value);
  if (!article) {
    info.hidden = true;
    return;
  }

  const q = Number($("#mvt-quantite").value) || 0;
  const apres = sortie ? (article.stock || 0) - q : (article.stock || 0) + q;
  let texte = `En stock : ${nb(article.stock)} ${article.unite}. Seuil d'alerte : ${nb(article.seuilAlerte)}.`;
  let niv = niveau(article);

  if (q > 0) {
    texte += ` Après ce mouvement : ${nb(apres)} ${article.unite}.`;
    niv = niveau({ stock: apres, seuilAlerte: article.seuilAlerte });
    if (apres < 0) texte += " La quantité dépasse le stock disponible.";
  }

  info.textContent = texte;
  info.dataset.niveau = niv;
  info.hidden = false;
}

$$('input[name="mvt-type"]').forEach((r) => r.addEventListener("change", majInfosMouvement));
$("#mvt-famille").addEventListener("change", rendreMouvement);
$("#mvt-article").addEventListener("change", majInfosMouvement);
$("#mvt-quantite").addEventListener("input", majInfosMouvement);

$("#btn-nouveau-benef").addEventListener("click", () => {
  const bloc = $("#form-nouveau-benef");
  bloc.hidden = !bloc.hidden;
  if (!bloc.hidden) $("#nb-libelle").focus();
});

async function creerBeneficiaire(type, libelle) {
  const propre = libelle.trim();
  if (!propre) {
    toast("Saisis des initiales ou un nom de service.", "erreur");
    return null;
  }
  const existe = etat.beneficiaires.some((b) => b.type === type && b.libelle.toLowerCase() === propre.toLowerCase());
  if (existe) {
    toast(`« ${propre} » existe déjà.`, "erreur");
    return null;
  }
  try {
    const id = await donnees.ajouterBeneficiaire(type, propre);
    toast(`${type === "agent" ? "Agent" : "Service"} « ${propre} » ajouté.`);
    return id;
  } catch (err) {
    toast(`Ajout impossible : ${err.message}`, "erreur");
    return null;
  }
}

async function ajouterBenefDepuisMouvement() {
  const id = await creerBeneficiaire($("#nb-type").value, $("#nb-libelle").value);
  if (!id) return;
  $("#nb-libelle").value = "";
  $("#form-nouveau-benef").hidden = true;
  etat.benefEnAttente = id;
  rendreMouvement();
}

$("#btn-ajouter-benef").addEventListener("click", ajouterBenefDepuisMouvement);
$("#nb-libelle").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    ajouterBenefDepuisMouvement();
  }
});

$("#form-mouvement").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = typeMouvement();
  const article = etat.articles.find((a) => a.id === $("#mvt-article").value);
  const quantite = Number($("#mvt-quantite").value);
  const beneficiaire = etat.beneficiaires.find((b) => b.id === $("#mvt-beneficiaire").value) || null;

  if (!article) {
    toast("Choisis un article.", "erreur");
    return;
  }
  if (!(quantite > 0)) {
    toast("La quantité doit être supérieure à zéro.", "erreur");
    return;
  }
  if (type === "sortie" && !beneficiaire) {
    toast("Indique à quel agent ou service la sortie est attribuée.", "erreur");
    return;
  }

  // Date du jour : on garde l'heure réelle pour l'ordre de l'historique.
  const jour = $("#mvt-date").value;
  const date = jour === isoJour(new Date()) ? new Date() : new Date(`${jour}T12:00:00`);

  const bouton = $("#mvt-valider");
  bouton.disabled = true;
  try {
    await donnees.enregistrerMouvement({
      articleId: article.id,
      type,
      quantite,
      date,
      beneficiaire: type === "sortie" ? beneficiaire : null,
      commentaire: $("#mvt-commentaire").value.trim()
    });
    toast(`${type === "sortie" ? "Sortie" : "Entrée"} enregistrée : ${nb(quantite)} ${article.unite} de ${article.designation}.`);
    $("#mvt-quantite").value = "";
    $("#mvt-commentaire").value = "";
    majInfosMouvement();
  } catch (err) {
    toast(err.message, "erreur");
  } finally {
    bouton.disabled = false;
  }
});

// ============================================================
// Historique
// ============================================================

function mouvementsFiltres() {
  const type = $("#hist-type").value;
  const articleId = $("#hist-article").value;
  const benefId = $("#hist-beneficiaire").value;
  return etat.mouvements.filter((m) =>
    (!type || m.type === type) &&
    (!articleId || m.articleId === articleId) &&
    (!benefId || m.beneficiaireId === benefId)
  );
}

function rendreHistorique() {
  remplirSelect($("#hist-article"), optionsArticles(articlesPartie({ archives: true }), "Tous les articles"));
  remplirSelect($("#hist-beneficiaire"), optionsBeneficiaires("Tous"));

  const liste = mouvementsFiltres();
  $("#hist-compte").textContent = liste.length ? `${liste.length} mouvement(s) sur la période.` : "";

  $("#hist-tbody").innerHTML = liste.length
    ? liste.map((m) => `
      <tr>
        <td>${formatDate(m.date)}</td>
        <td><span class="pastille pastille-${m.type}">${m.type === "entree" ? "Entrée" : "Sortie"}</span></td>
        <td>
          <span class="cellule-nom">${esc(m.designation)}</span>
          <span class="cellule-ref">${esc(m.reference)}</span>
        </td>
        <td class="num">${m.type === "entree" ? "+" : "−"}${nb(m.quantite)} ${esc(m.unite)}</td>
        <td>${esc(m.beneficiaireLibelle) || "—"}</td>
        <td class="num">${nb(m.stockApres)}</td>
        <td>${esc(m.commentaire)}</td>
        <td><button type="button" class="btn-lien" data-annuler="${m.id}" data-ecriture>Annuler</button></td>
      </tr>`).join("")
    : `<tr><td colspan="8" class="vide">Aucun mouvement sur cette période avec ces filtres.</td></tr>`;

  rendreRecap(liste);
}

function recapSorties(liste) {
  const totaux = new Map();
  for (const m of liste.filter((x) => x.type === "sortie")) {
    const cle = `${m.beneficiaireLibelle}|${m.articleId}`;
    if (!totaux.has(cle)) {
      totaux.set(cle, {
        beneficiaire: m.beneficiaireLibelle || "Non attribué",
        type: m.beneficiaireType,
        designation: m.designation,
        reference: m.reference,
        unite: m.unite,
        quantite: 0
      });
    }
    totaux.get(cle).quantite += m.quantite;
  }
  return [...totaux.values()].sort((a, b) => triFr(a.beneficiaire, b.beneficiaire) || triFr(a.designation, b.designation));
}

function rendreRecap(liste) {
  const recap = recapSorties(liste);
  $("#hist-recap").innerHTML = recap.length
    ? `<div class="tableau-conteneur">
        <table class="tableau">
          <thead><tr><th>Attribué à</th><th>Article</th><th class="num">Quantité</th></tr></thead>
          <tbody>
            ${recap.map((l) => `
              <tr>
                <td>${esc(l.beneficiaire)}</td>
                <td>${esc(l.designation)} <span class="cellule-ref">${esc(l.reference)}</span></td>
                <td class="num">${nb(l.quantite)} ${esc(l.unite)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`
    : `<p class="vide">Aucune sortie sur la période.</p>`;
}

$("#hist-du").addEventListener("change", abonnerMouvements);
$("#hist-au").addEventListener("change", abonnerMouvements);
["#hist-type", "#hist-article", "#hist-beneficiaire"].forEach((s) => $(s).addEventListener("change", rendreHistorique));

$("#hist-tbody").addEventListener("click", async (e) => {
  const bouton = e.target.closest("[data-annuler]");
  if (!bouton) return;
  const m = etat.mouvements.find((x) => x.id === bouton.dataset.annuler);
  if (!m) return;
  const sens = m.type === "entree" ? "retiré du" : "remis en";
  if (!confirm(`Annuler ce mouvement ? ${nb(m.quantite)} ${m.unite} de ${m.designation} seront ${sens} stock.`)) return;
  try {
    await donnees.annulerMouvement(m.id);
    toast("Mouvement annulé, stock corrigé.");
  } catch (err) {
    toast(err.message, "erreur");
  }
});

$("#btn-export").addEventListener("click", () => {
  if (!window.XLSX) {
    toast("Export indisponible : la bibliothèque Excel n'est pas chargée.", "erreur");
    return;
  }
  const liste = mouvementsFiltres();
  const libelleType = (t) => (t === "agent" ? "Agent" : t === "service" ? "Service" : "");

  // « Nom complet » reste vide volontairement (aucun nom stocké côté serveur).
  const feuilleMouvements = liste.map((m) => ({
    "Date": formatDate(m.date),
    "Type": m.type === "entree" ? "Entrée" : "Sortie",
    "Référence": m.reference,
    "Article": m.designation,
    "Famille": nomFamille(m.familleId),
    "Quantité": m.quantite,
    "Unité": m.unite,
    "Attribué à": m.beneficiaireLibelle,
    "Agent / service": libelleType(m.beneficiaireType),
    "Nom complet": "",
    "Stock après": m.stockApres,
    "Commentaire": m.commentaire
  }));

  const feuilleRecap = recapSorties(liste).map((l) => ({
    "Attribué à": l.beneficiaire,
    "Agent / service": libelleType(l.type),
    "Nom complet": "",
    "Référence": l.reference,
    "Article": l.designation,
    "Quantité": Math.round(l.quantite * 100) / 100,
    "Unité": l.unite
  }));

  const feuilleStock = articlesPartie()
    .sort((a, b) => triFr(nomFamille(a.familleId), nomFamille(b.familleId)) || triFr(a.designation, b.designation))
    .map((a) => ({
      "Famille": nomFamille(a.familleId),
      "Référence": a.reference,
      "Article": a.designation,
      "Unité": a.unite,
      "Stock": a.stock,
      "Seuil d'alerte": a.seuilAlerte,
      "Stock cible": a.stockCible || "",
      "À commander": aCommander(a) || "",
      "État": { ok: "OK", alerte: "Sous le seuil", rupture: "Rupture" }[niveau(a)]
    }));

  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, XLSX.utils.json_to_sheet(feuilleMouvements), "Mouvements");
  XLSX.utils.book_append_sheet(classeur, XLSX.utils.json_to_sheet(feuilleRecap), "Sorties par agent-service");
  XLSX.utils.book_append_sheet(classeur, XLSX.utils.json_to_sheet(feuilleStock), "État du stock");
  XLSX.writeFile(classeur, `stock-${etat.partie}-${$("#hist-du").value}_${$("#hist-au").value}.xlsx`);
});

// ============================================================
// Articles
// ============================================================

function rendreArticles() {
  const recherche = $("#art-recherche").value.trim().toLowerCase();
  const tous = articlesPartie({ archives: true });
  const articles = articlesPartie({ archives: $("#art-archives").checked })
    .filter((a) => !recherche || `${a.reference} ${a.designation}`.toLowerCase().includes(recherche))
    .sort((a, b) => triFr(nomFamille(a.familleId), nomFamille(b.familleId)) || triFr(a.designation, b.designation));

  $("#art-tbody").innerHTML = articles.length
    ? articles.map((a) => `
      <tr class="${a.actif === false ? "archive" : ""}">
        <td>${esc(a.reference)}</td>
        <td>${esc(a.designation)}</td>
        <td>${esc(nomFamille(a.familleId))}</td>
        <td>${esc(a.unite)}</td>
        <td class="num">${nb(a.seuilAlerte)}</td>
        <td class="num">${a.stockCible ? nb(a.stockCible) : "—"}</td>
        <td class="num"><span class="stock-${niveau(a)}">${nb(a.stock)}</span></td>
        <td class="actions">
          <button type="button" class="btn-lien" data-modifier="${a.id}" data-ecriture>Modifier</button>
          <button type="button" class="btn-lien" data-archiver="${a.id}" data-ecriture>${a.actif === false ? "Réactiver" : "Archiver"}</button>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="8" class="vide">${tous.length ? "Aucun article ne correspond à la recherche." : "Aucun article. Clique sur « Nouvel article » pour commencer."}</td></tr>`;
}

$("#art-recherche").addEventListener("input", rendreArticles);
$("#art-archives").addEventListener("change", rendreArticles);
$("#btn-nouvel-article").addEventListener("click", () => ouvrirModaleArticle());

$("#art-tbody").addEventListener("click", async (e) => {
  const bouton = e.target.closest("button");
  if (!bouton) return;

  if (bouton.dataset.modifier) {
    ouvrirModaleArticle(etat.articles.find((a) => a.id === bouton.dataset.modifier));
  }

  if (bouton.dataset.archiver) {
    const article = etat.articles.find((a) => a.id === bouton.dataset.archiver);
    const reactiver = article.actif === false;
    try {
      await donnees.archiverArticle(article.id, reactiver);
      toast(reactiver ? "Article réactivé." : "Article archivé. Son historique est conservé.");
    } catch (err) {
      toast(err.message, "erreur");
    }
  }
});

function ouvrirModaleArticle(article = null) {
  const familles = famillesPartie();
  if (!familles.length) {
    toast("Crée d'abord une famille dans l'onglet Familles & agents.", "erreur");
    changerVue("parametres");
    $("#famille-nom").focus();
    return;
  }

  const form = $("#form-article");
  form.reset();
  form.dataset.id = article?.id || "";
  $("#modale-article-titre").textContent = article ? "Modifier l'article" : `Nouvel article – ${PARTIES[etat.partie]}`;
  $("#art-famille").innerHTML = `<option value="">Choisir une famille</option>${familles.map((f) => `<option value="${f.id}">${esc(f.nom)}</option>`).join("")}`;
  $("#champ-stock-initial").hidden = Boolean(article);

  if (article) {
    $("#art-reference").value = article.reference;
    $("#art-designation").value = article.designation;
    $("#art-famille").value = article.familleId;
    $("#art-unite").value = article.unite;
    $("#art-seuil").value = article.seuilAlerte;
    $("#art-cible").value = article.stockCible || "";
  }

  $("#modale-article").showModal();
  $("#art-reference").focus();
}

$("#btn-annuler-article").addEventListener("click", () => $("#modale-article").close());

$("#form-article").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = e.currentTarget.dataset.id;
  const champs = {
    reference: $("#art-reference").value.trim(),
    designation: $("#art-designation").value.trim(),
    familleId: $("#art-famille").value,
    unite: $("#art-unite").value.trim() || "pièce",
    seuilAlerte: Number($("#art-seuil").value) || 0,
    stockCible: Number($("#art-cible").value) || 0
  };

  if (champs.stockCible > 0 && champs.stockCible <= champs.seuilAlerte) {
    toast("Le stock cible doit être supérieur au seuil d'alerte.", "erreur");
    return;
  }

  const doublon = etat.articles.some((a) =>
    a.partie === etat.partie &&
    a.id !== id &&
    a.reference.toLowerCase() === champs.reference.toLowerCase()
  );
  if (doublon) {
    toast(`La référence ${champs.reference} existe déjà.`, "erreur");
    return;
  }

  try {
    if (id) {
      await donnees.modifierArticle(id, champs);
      toast("Article modifié.");
    } else {
      await donnees.ajouterArticle({ ...champs, partie: etat.partie }, Number($("#art-stock-initial").value) || 0);
      toast("Article créé.");
    }
    $("#modale-article").close();
  } catch (err) {
    toast(`Enregistrement impossible : ${err.message}`, "erreur");
  }
});

// ============================================================
// Familles & agents
// ============================================================

function rendreParametres() {
  $("#param-partie").textContent = PARTIES[etat.partie];

  const familles = famillesPartie();
  $("#liste-familles").innerHTML = familles.length
    ? familles.map((f) => {
      const n = etat.articles.filter((a) => a.familleId === f.id).length;
      return `
        <li>
          <span>${esc(f.nom)} <small>${n} article(s)</small></span>
          <span class="actions" data-ecriture>
            <button type="button" class="btn-lien" data-renommer="${f.id}">Renommer</button>
            <button type="button" class="btn-lien" data-supprimer-famille="${f.id}" ${n ? `disabled title="Utilisée par ${n} article(s)"` : ""}>Supprimer</button>
          </span>
        </li>`;
    }).join("")
    : `<li class="vide">Aucune famille pour l'instant.</li>`;

  const listes = [["agent", "#liste-agents", "Aucun agent enregistré."], ["service", "#liste-services", "Aucun service enregistré."]];
  for (const [type, cible, vide] of listes) {
    const liste = etat.beneficiaires
      .filter((b) => b.type === type)
      .sort((a, b) => triFr(a.libelle, b.libelle));
    $(cible).innerHTML = liste.length
      ? liste.map((b) => `
        <li>
          <span>${esc(b.libelle)}</span>
          <button type="button" class="btn-lien" data-supprimer-benef="${b.id}" data-ecriture>Supprimer</button>
        </li>`).join("")
      : `<li class="vide">${vide}</li>`;
  }
}

$("#form-famille").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nom = $("#famille-nom").value.trim();
  if (famillesPartie().some((f) => f.nom.toLowerCase() === nom.toLowerCase())) {
    toast(`La famille « ${nom} » existe déjà.`, "erreur");
    return;
  }
  try {
    await donnees.ajouterFamille(etat.partie, nom);
    $("#famille-nom").value = "";
    toast(`Famille « ${nom} » ajoutée.`);
  } catch (err) {
    toast(`Ajout impossible : ${err.message}`, "erreur");
  }
});

$("#liste-familles").addEventListener("click", async (e) => {
  const bouton = e.target.closest("button");
  if (!bouton) return;

  if (bouton.dataset.renommer) {
    const famille = etat.familles.find((f) => f.id === bouton.dataset.renommer);
    const nom = prompt("Nouveau nom de la famille :", famille.nom)?.trim();
    if (!nom || nom === famille.nom) return;
    try {
      await donnees.renommerFamille(famille.id, nom);
      toast("Famille renommée.");
    } catch (err) {
      toast(err.message, "erreur");
    }
  }

  if (bouton.dataset.supprimerFamille) {
    const famille = etat.familles.find((f) => f.id === bouton.dataset.supprimerFamille);
    if (!confirm(`Supprimer la famille « ${famille.nom} » ?`)) return;
    try {
      await donnees.supprimerFamille(famille.id);
      toast("Famille supprimée.");
    } catch (err) {
      toast(err.message, "erreur");
    }
  }
});

$("#form-benef").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = await creerBeneficiaire($("#benef-type").value, $("#benef-libelle").value);
  if (id) $("#benef-libelle").value = "";
});

["#liste-agents", "#liste-services"].forEach((s) => $(s).addEventListener("click", async (e) => {
  const bouton = e.target.closest("[data-supprimer-benef]");
  if (!bouton) return;
  const b = etat.beneficiaires.find((x) => x.id === bouton.dataset.supprimerBenef);
  if (!confirm(`Supprimer « ${b.libelle} » ? Les sorties déjà enregistrées gardent ce nom dans l'historique.`)) return;
  try {
    await donnees.supprimerBeneficiaire(b.id);
    toast("Supprimé.");
  } catch (err) {
    toast(err.message, "erreur");
  }
}));

// ============================================================
// Valeurs par défaut
// ============================================================

$("#mvt-date").value = isoJour(new Date());
$("#hist-du").value = isoJour(decalerJours(-90));
$("#hist-au").value = isoJour(new Date());