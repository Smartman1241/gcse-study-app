/* ===============================
   GCSE Focus - studysets.js
   Create/manage study sets
   Flashcards + MCQs (Learn mode)
   =============================== */
(() => {
  "use strict";

  const { $, $$, uid, escapeHtml, toast } = window.Utils;
  const { state, save, bus, setActiveSet, getActiveSet } = window.App;

  // --- Elements ---
  const el = {
    // Create set
    setName: $("#setName"),
    setSubject: $("#setSubject"),
    setDesc: $("#setDesc"),
    createBtn: $("#btnCreateSet"),
    addDemoBtn: $("#btnAddDemo"),

    // Set list
    setList: $("#setList"),
    setCount: $("#setCount"),
    setSearch: $("#setSearch"),
    deleteSetBtn: $("#btnDeleteSet"),

    // Active set display
    activeSetName: $("#activeSetName"),
    activeSetMeta: $("#activeSetMeta"),

    // Flashcards
    cardFront: $("#cardFront"),
    cardBack: $("#cardBack"),
    addCardBtn: $("#btnAddCard"),
    cardList: $("#cardList"),
    cardCount: $("#cardCount"),

    // MCQ
    mcqQ: $("#mcqQ"),
    mcqA: $("#mcqA"),
    mcqB: $("#mcqB"),
    mcqC: $("#mcqC"),
    mcqD: $("#mcqD"),
    mcqCorrect: $("#mcqCorrect"),
    addMcqBtn: $("#btnAddMcq"),
    mcqList: $("#mcqList"),
    mcqCount: $("#mcqCount"),
  };

  // ---------- Helpers ----------
  function getCards(setId) {
    return state.cardsBySet[setId] || [];
  }

  function getMcqs(setId) {
    return state.mcqBySet[setId] || [];
  }

  function ensureSetContainers(setId) {
    if (!state.cardsBySet[setId]) state.cardsBySet[setId] = [];
    if (!state.mcqBySet[setId]) state.mcqBySet[setId] = [];
  }

  function filteredSets() {
    const q = (el.setSearch.value || "").toLowerCase().trim();
    if (!q) return state.studySets;
    return state.studySets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.subject || "").toLowerCase().includes(q)
    );
  }

  // ---------- Create / Delete Set ----------
  function createSet() {
    const name = (el.setName.value || "").trim();
    if (!name) return toast("Enter a set name.");

    const set = {
      id: uid(),
      name,
      subject: el.setSubject.value || "Other",
      desc: (el.setDesc.value || "").trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    state.studySets.unshift(set);
    ensureSetContainers(set.id);

    el.setName.value = "";
    el.setDesc.value = "";

    save();
    renderSets();
    setActiveSet(set.id);
    toast("Study set created.");
  }

  function deleteSet() {
    const active = getActiveSet();
    if (!active) return;

    if (!confirm(`Delete set "${active.name}"?`)) return;

    state.studySets = state.studySets.filter((s) => s.id !== active.id);
    delete state.cardsBySet[active.id];
    delete state.mcqBySet[active.id];

    setActiveSet(null);
    save();
    renderSets();
    renderActiveSet();
    toast("Set deleted.");
  }

  // ---------- Flashcards ----------
  function addCard() {
    const active = getActiveSet();
    if (!active) return toast("Select a set first.");

    const front = (el.cardFront.value || "").trim();
    const back = (el.cardBack.value || "").trim();
    if (!front || !back) return toast("Fill front and back.");

    ensureSetContainers(active.id);

    state.cardsBySet[active.id].push({
      id: uid(),
      front,
      back,
      createdAt: Date.now(),
    });

    el.cardFront.value = "";
    el.cardBack.value = "";

    save();
    renderCards();
    toast("Flashcard added.");
  }

  function deleteCard(cardId) {
    const active = getActiveSet();
    if (!active) return;

    state.cardsBySet[active.id] =
      getCards(active.id).filter((c) => c.id !== cardId);

    save();
    renderCards();
  }

  // ---------- MCQs ----------
  function addMcq() {
    const active = getActiveSet();
    if (!active) return toast("Select a set first.");

    const q = (el.mcqQ.value || "").trim();
    const A = (el.mcqA.value || "").trim();
    const B = (el.mcqB.value || "").trim();
    const C = (el.mcqC.value || "").trim();
    const D = (el.mcqD.value || "").trim();
    const correct = el.mcqCorrect.value;

    if (!q || !A || !B || !C || !D)
      return toast("Fill all MCQ fields.");

    ensureSetContainers(active.id);

    state.mcqBySet[active.id].push({
      id: uid(),
      q,
      opts: { A, B, C, D },
      correct,
      createdAt: Date.now(),
    });

    el.mcqQ.value = "";
    el.mcqA.value = "";
    el.mcqB.value = "";
    el.mcqC.value = "";
    el.mcqD.value = "";

    save();
    renderMcqs();
    toast("MCQ added.");
  }

  function deleteMcq(id) {
    const active = getActiveSet();
    if (!active) return;

    state.mcqBySet[active.id] =
      getMcqs(active.id).filter((m) => m.id !== id);

    save();
    renderMcqs();
  }

  // ---------- Rendering ----------
  function renderSets() {
    el.setCount.textContent = state.studySets.length;
    el.setList.innerHTML = "";

    const list = filteredSets();
    if (list.length === 0) {
      el.setList.innerHTML =
        '<div class="muted small">No study sets yet.</div>';
      return;
    }

    list.forEach((s) => {
      const div = document.createElement("div");
      div.className = "listItem";
      div.style.cursor = "pointer";

      if (state.activeSetId === s.id) {
        div.style.borderColor = "var(--primary)";
      }

      div.innerHTML = `
        <div>
          <strong>${escapeHtml(s.name)}</strong><br/>
          <span class="muted small">${escapeHtml(s.subject)}</span>
        </div>
      `;

      div.addEventListener("click", () => {
        setActiveSet(s.id);
      });

      el.setList.appendChild(div);
    });
  }

  function renderActiveSet() {
    const active = getActiveSet();

    if (!active) {
      el.activeSetName.textContent = "No set selected";
      el.activeSetMeta.textContent = "Pick a set to manage it.";
      el.addCardBtn.disabled = true;
      el.addMcqBtn.disabled = true;
      el.deleteSetBtn.disabled = true;
      el.cardList.innerHTML = "";
      el.mcqList.innerHTML = "";
      el.cardCount.textContent = "0";
      el.mcqCount.textContent = "0";
      return;
    }

    el.activeSetName.textContent = active.name;
    el.activeSetMeta.textContent = `${active.subject} • ${active.desc || ""}`;
    el.addCardBtn.disabled = false;
    el.addMcqBtn.disabled = false;
    el.deleteSetBtn.disabled = false;

    renderCards();
    renderMcqs();
  }

  function renderCards() {
    const active = getActiveSet();
    if (!active) return;

    const cards = getCards(active.id);
    el.cardCount.textContent = cards.length;
    el.cardList.innerHTML = "";

    cards.forEach((c) => {
      const div = document.createElement("div");
      div.className = "listItem";

      div.innerHTML = `
        <div>
          <strong>${escapeHtml(c.front)}</strong><br/>
          <span class="muted small">${escapeHtml(c.back)}</span>
        </div>
        <button class="btn">🗑</button>
      `;

      div.querySelector("button").addEventListener("click", () =>
        deleteCard(c.id)
      );

      el.cardList.appendChild(div);
    });
  }

  function renderMcqs() {
    const active = getActiveSet();
    if (!active) return;

    const mcqs = getMcqs(active.id);
    el.mcqCount.textContent = mcqs.length;
    el.mcqList.innerHTML = "";

    mcqs.forEach((m) => {
      const div = document.createElement("div");
      div.className = "listItem";

      div.innerHTML = `
        <div>
          <strong>${escapeHtml(m.q)}</strong><br/>
          <span class="muted small">Correct: ${m.correct}</span>
        </div>
        <button class="btn">🗑</button>
      `;

      div.querySelector("button").addEventListener("click", () =>
        deleteMcq(m.id)
      );

      el.mcqList.appendChild(div);
    });
  }

  // ---------- Demo ----------
  function addDemoData() {
    if (state.studySets.length > 0) {
      if (!confirm("Add demo data on top of current sets?")) return;
    }

    const setId = uid();
    const set = {
      id: setId,
      name: "Biology: Cell Structure",
      subject: "Biology",
      desc: "Core GCSE cell knowledge",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    state.studySets.push(set);
    state.cardsBySet[setId] = [
      { id: uid(), front: "Define osmosis", back: "Movement of water from high to low concentration through a semi-permeable membrane." },
      { id: uid(), front: "Function of mitochondria?", back: "Site of aerobic respiration." }
    ];

    state.mcqBySet[setId] = [
      {
        id: uid(),
        q: "What is the powerhouse of the cell?",
        opts: { A: "Nucleus", B: "Mitochondria", C: "Ribosome", D: "Chloroplast" },
        correct: "B"
      }
    ];

    save();
    renderSets();
    toast("Demo data added.");
  }

  // ---------- Init ----------
  function init() {
    if (!el.createBtn) return;

    el.createBtn.addEventListener("click", createSet);
    el.deleteSetBtn.addEventListener("click", deleteSet);
    el.addCardBtn.addEventListener("click", addCard);
    el.addMcqBtn.addEventListener("click", addMcq);
    el.setSearch.addEventListener("input", renderSets);
    el.addDemoBtn.addEventListener("click", addDemoData);

    bus.on("set:active", renderActiveSet);
    bus.on("app:imported", () => {
      renderSets();
      renderActiveSet();
    });

    renderSets();
    renderActiveSet();
  }

  bus.on("app:ready", init);
})();