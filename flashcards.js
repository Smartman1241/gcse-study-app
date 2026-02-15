/* ===============================
   GCSE Focus - flashcards.js
   Flashcard study mode: set select, shuffle, next/prev, flip
   =============================== */
(() => {
  "use strict";

  const { $, shuffle, escapeHtml, toast } = window.Utils;
  const { state, bus, save } = window.App;

  // Elements
  const el = {
    setSelect: $("#flashSetSelect"),
    btnShuffle: $("#btnFlashShuffle"),
    btnPrev: $("#btnFlashPrev"),
    btnFlip: $("#btnFlashFlip"),
    btnNext: $("#btnFlashNext"),

    pos: $("#flashPos"),
    card: $("#flashCard"),
    front: $("#flashFront"),
    back: $("#flashBack"),
  };

  // Local session state
  let session = {
    setId: null,
    order: [],   // array of card IDs in current order
    index: 0,
    showingBack: false,
  };

  function getSetNameById(id) {
    const s = state.studySets.find(x => x.id === id);
    return s ? s.name : "(Unknown set)";
  }

  function getCards(setId) {
    return (state.cardsBySet && state.cardsBySet[setId]) ? state.cardsBySet[setId] : [];
  }

  function fillSetSelect() {
    if (!el.setSelect) return;

    const current = el.setSelect.value || session.setId || "";
    el.setSelect.innerHTML = "";

    if (state.studySets.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No study sets yet";
      el.setSelect.appendChild(opt);
      el.setSelect.disabled = true;
      return;
    }

    el.setSelect.disabled = false;

    state.studySets.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      el.setSelect.appendChild(opt);
    });

    // keep selection if possible
    if (current && state.studySets.some(s => s.id === current)) {
      el.setSelect.value = current;
    } else {
      // default: active set if exists, else first set
      const fallback = state.activeSetId && state.studySets.some(s => s.id === state.activeSetId)
        ? state.activeSetId
        : state.studySets[0].id;
      el.setSelect.value = fallback;
    }
  }

  function startSet(setId, doShuffle = false) {
    session.setId = setId;
    session.index = 0;
    session.showingBack = false;

    const cards = getCards(setId);
    if (!cards.length) {
      session.order = [];
      render();
      return;
    }

    session.order = cards.map(c => c.id);
    if (doShuffle) session.order = shuffle(session.order);

    render();
  }

  function currentCard() {
    if (!session.setId || !session.order.length) return null;
    const cards = getCards(session.setId);
    const id = session.order[session.index];
    return cards.find(c => c.id === id) || null;
  }

  function render() {
    const setId = el.setSelect?.value || session.setId;

    if (!setId) {
      el.pos.textContent = "0 / 0";
      el.front.textContent = "Create a study set first.";
      el.back.hidden = true;
      return;
    }

    const cards = getCards(setId);
    if (!cards.length) {
      el.pos.textContent = "0 / 0";
      el.front.textContent = `No cards in "${getSetNameById(setId)}" yet. Add flashcards in Study Sets.`;
      el.back.hidden = true;
      return;
    }

    // If our session isn't set or mismatched, initialize
    if (session.setId !== setId || session.order.length !== cards.length) {
      startSet(setId, false);
      return;
    }

    const card = currentCard();
    el.pos.textContent = `${session.index + 1} / ${session.order.length}`;

    if (!card) {
      el.front.textContent = "Card not found.";
      el.back.hidden = true;
      return;
    }

    // Show side
    if (session.showingBack) {
      el.front.hidden = true;
      el.back.hidden = false;
      el.back.innerHTML = escapeHtml(card.back);
    } else {
      el.front.hidden = false;
      el.back.hidden = true;
      el.front.innerHTML = escapeHtml(card.front);
    }
  }

  function flip() {
    const setId = el.setSelect.value;
    const cards = getCards(setId);
    if (!cards.length) return toast("No cards in this set yet.");
    session.showingBack = !session.showingBack;
    render();
  }

  function next() {
    const setId = el.setSelect.value;
    const cards = getCards(setId);
    if (!cards.length) return;

    session.showingBack = false;
    session.index = (session.index + 1) % session.order.length;
    render();
  }

  function prev() {
    const setId = el.setSelect.value;
    const cards = getCards(setId);
    if (!cards.length) return;

    session.showingBack = false;
    session.index = (session.index - 1 + session.order.length) % session.order.length;
    render();
  }

  function reshuffle() {
    const setId = el.setSelect.value;
    const cards = getCards(setId);
    if (!cards.length) return toast("No cards to shuffle.");

    session.order = shuffle(session.order);
    session.index = 0;
    session.showingBack = false;
    render();
    toast("Shuffled.");
  }

  function onSetChange() {
    const setId = el.setSelect.value;
    if (!setId) return render();
    startSet(setId, false);

    // optional: sync active set to keep everything aligned
    state.activeSetId = setId;
    save();
    bus.emit("set:active", { setId });
  }

  function init() {
    if (!el.setSelect) return;

    fillSetSelect();

    el.setSelect.addEventListener("change", onSetChange);
    el.btnFlip.addEventListener("click", flip);
    el.btnNext.addEventListener("click", next);
    el.btnPrev.addEventListener("click", prev);
    el.btnShuffle.addEventListener("click", reshuffle);

    // Initial session
    if (el.setSelect.value) startSet(el.setSelect.value, false);
    else render();

    // When sets change (created/deleted/import), refresh select + rerender
    bus.on("app:imported", () => {
      fillSetSelect();
      if (el.setSelect.value) startSet(el.setSelect.value, false);
      else render();
    });

    bus.on("set:active", ({ setId }) => {
      // Keep dropdown aligned with active set if user changes it elsewhere
      fillSetSelect();
      if (setId && el.setSelect.value !== setId) {
        el.setSelect.value = setId;
        startSet(setId, false);
      } else {
        render();
      }
    });
  }

  bus.on("app:ready", init);
})();