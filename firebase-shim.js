/* Collega l'app all'archivio Firebase dell'agenzia (dati, foto, accesso). */
(function(){
  "use strict";
  var cfg = window.RELAX_FIREBASE_CONFIG || {};
  var configured = !!(cfg.apiKey && cfg.projectId && cfg.apiKey.indexOf("INSERISCI") !== 0 && window.firebase);
  var BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  var photoCache = new Map();
  var fs = null, resolveAuth, authed = new Promise(function(r){ resolveAuth = r; });

  function withTimeout(p, ms){ return Promise.race([p, new Promise(function(r){ setTimeout(function(){ r("queued"); }, ms || 3500); })]); }
  window.__wt = withTimeout;

  function el(html){ var d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }
  var overlay = null;
  function showOverlay(inner){
    if (!overlay){ overlay = el('<div id="authOverlay" class="auth"></div>'); document.body.appendChild(overlay); }
    overlay.innerHTML = '<div class="auth-in"><img src="logo.png" alt="Relax Immobiliare" class="auth-logo"><h1>Relax in Zona</h1>' + inner + '</div>';
    overlay.hidden = false;
  }
  function hideOverlay(){ if (overlay) overlay.hidden = true; }

  function showLogin(msg){
    showOverlay(
      '<form id="loginForm" class="auth-form" novalidate>' +
      '<label for="lgEmail">Email</label><input id="lgEmail" type="email" autocomplete="username" inputmode="email" required>' +
      '<label for="lgPass">Password</label><input id="lgPass" type="password" autocomplete="current-password" required>' +
      '<p class="auth-err" id="lgErr" role="alert">' + (msg || "") + '</p>' +
      '<button class="btn pri" type="submit" id="lgBtn">Accedi</button>' +
      '<button class="auth-link" type="button" id="lgReset">Password dimenticata?</button>' +
      '</form><p class="auth-note">L\'account lo crea il titolare dell\'agenzia.</p>');
    var f = document.getElementById("loginForm");
    f.addEventListener("submit", function(e){
      e.preventDefault();
      var em = document.getElementById("lgEmail").value.trim(), pw = document.getElementById("lgPass").value;
      var err = document.getElementById("lgErr"), btn = document.getElementById("lgBtn");
      if (!em || !pw){ err.textContent = "Inserisci email e password."; return; }
      btn.disabled = true; btn.textContent = "Accesso in corso…"; err.textContent = "";
      firebase.auth().signInWithEmailAndPassword(em, pw).catch(function(x){
        btn.disabled = false; btn.textContent = "Accedi";
        var c = x && x.code || "";
        err.textContent = (c.indexOf("network") >= 0) ? "Nessuna connessione. Riprova quando sei online."
          : (c === "auth/too-many-requests") ? "Troppi tentativi. Aspetta qualche minuto e riprova."
          : "Email o password non corrette.";
      });
    });
    document.getElementById("lgReset").addEventListener("click", function(){
      var em = document.getElementById("lgEmail").value.trim(), err = document.getElementById("lgErr");
      if (!em){ err.textContent = "Scrivi prima la tua email, poi tocca di nuovo qui."; return; }
      firebase.auth().sendPasswordResetEmail(em).then(function(){ err.textContent = "Ti abbiamo mandato un'email per scegliere una nuova password."; })
        .catch(function(){ err.textContent = "Invio non riuscito. Controlla l'email inserita."; });
    });
  }

  if (!configured){
    document.addEventListener("DOMContentLoaded", function(){
      showOverlay('<p class="auth-note">L\'app non è ancora collegata all\'archivio dell\'agenzia.<br>Inserisci i dati Firebase nel file <b>config.js</b> e ricrea l\'app.</p>');
    });
  } else {
    firebase.initializeApp(cfg);
    fs = firebase.firestore();
    fs.enablePersistence({ synchronizeTabs: false }).catch(function(){});
    firebase.auth().onAuthStateChanged(function(u){
      if (u){ hideOverlay(); resolveAuth(u); }
      else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ showLogin(); });
      else showLogin();
    });
  }
  window.__logout = function(){ if (configured) firebase.auth().signOut().then(function(){ location.reload(); }); };
  window.__userEmail = function(){ var u = configured && firebase.auth().currentUser; return u ? u.email : ""; };

  /* ---- foto: salvate come immagini compresse nell'archivio ---- */
  function blobToDataURL(b){ return new Promise(function(res, rej){ var r = new FileReader(); r.onload = function(){ res(r.result); }; r.onerror = rej; r.readAsDataURL(b); }); }
  function loadImg(src){ return new Promise(function(res, rej){ var i = new Image(); i.onload = function(){ res(i); }; i.onerror = rej; i.src = src; }); }
  async function fit(blob){
    var url = await blobToDataURL(blob);
    if (url.length <= 900000) return url;
    var img = await loadImg(url);
    var tries = [[1280, .7], [1100, .62], [960, .55], [800, .5]];
    for (var k = 0; k < tries.length; k++){
      var max = tries[k][0], q = tries[k][1], s = Math.min(1, max / Math.max(img.width, img.height));
      var c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      var out = c.toDataURL("image/jpeg", q);
      if (out.length <= 900000) return out;
    }
    throw { code: "too_large", message: "Foto troppo grande" };
  }
  var assetsApi = {
    upload: async function(blob){
      var data = await fit(blob);
      var ref = fs.collection("foto").doc();
      await withTimeout(ref.set({ d: data, t: Date.now() }), 6000);
      photoCache.set(ref.id, data);
      return { id: ref.id, url: data, sizeBytes: data.length, contentType: "image/jpeg" };
    },
    list: async function(){ return { assets: [], usage: {} }; },
    delete: async function(id){ try { await withTimeout(fs.collection("foto").doc(id).delete()); } catch(e){} return { deleted: true }; }
  };
  window.__photoSrc = function(id){ return photoCache.get(id) || BLANK; };

  var loading = new Set();
  function hydrate(root){
    if (!fs) return;
    (root || document).querySelectorAll("img[data-fid]").forEach(function(img){
      var id = img.getAttribute("data-fid");
      if (photoCache.has(id)){ if (img.src !== photoCache.get(id)) img.src = photoCache.get(id); return; }
      if (loading.has(id)) return;
      loading.add(id);
      fs.collection("foto").doc(id).get().then(function(s){
        loading.delete(id);
        if (s.exists && s.data().d){ photoCache.set(id, s.data().d); }
        document.querySelectorAll('img[data-fid="' + id + '"]').forEach(function(i){
          if (photoCache.has(id)) i.src = photoCache.get(id);
          else { var p = i.closest(".ph"); if (p) p.classList.add("broken"); }
        });
      }).catch(function(){ loading.delete(id); });
    });
  }
  new MutationObserver(function(){ hydrate(); }).observe(document.documentElement, { childList: true, subtree: true });

  var downloadsApi = {
    save: async function(o){
      if (window.AndroidBridge && window.AndroidBridge.shareFile){ window.AndroidBridge.shareFile(o.filename, String(o.data)); return { status: "saved" }; }
      var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([o.data], { type: "text/csv" })); a.download = o.filename; a.click();
      return { status: "saved" };
    }
  };

  window.claude = {
    use: function(name){
      if (!configured) return Promise.resolve(null);
      if (name === "downloads") return Promise.resolve(downloadsApi);
      if (name === "db") return authed.then(function(){ return fs; });
      if (name === "assets") return authed.then(function(){ return assetsApi; });
      return Promise.resolve(null);
    }
  };
})();
