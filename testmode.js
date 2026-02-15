/* ===============================
   GCSE Focus - testmode.js
   Typed Test Mode using flashcards
   Fuzzy match (<=1 char allowed)
   =============================== */
(() => {
  "use strict";

  const { $, shuffle, fuzzyCheck, percent, escapeHtml, toast } = window.Utils;
  const { state, bus } = window.App;

  const el = {
    setSelect: $("#testSetSelect"),
    startBtn: $("#btnTestStart"),
    skipBtn: $("#btnTestSkip"),
    stage: $("#testStage"),
    score: $("#testScore"),
    progress: $("#testProgress"),
  };

  let session = {
    setId: null,
    cards: [],
    index: 0,
    correct: 0,
    answered: 0,
    active: false,
  };

  function getCards(setId) {
    return (state.cardsBySet && state.cardsBySet[setId]) || [];
  }

  function fillSetSelect() {
    if (!el.setSelect) return;

    el.setSelect.innerHTML = "";

    if (state.studySets.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No study sets";
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

    if (state.activeSetId && state.studySets.some(s => s.id === state.activeSetId)) {
      el.setSelect.value = state.activeSetId;
    }
  }

  function start() {
    const setId = el.setSelect.value;
    if (!setId) return toast("Choose a study set.");

    const cards = getCards(setId);
    if (!cards.length) return toast("This set has no flashcards.");

    session = {
      setId,
      cards: shuffle(cards),
      index: 0,
      correct: 0,
      answered: 0,
      active: true,
    };

    renderQuestion();
    updateStats();
  }

  function renderQuestion() {
    const card = session.cards[session.index];
    if (!card) {
      el.stage.innerHTML = `<p class="muted">No questions found.</p>`;
      return;
    }

    el.stage.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(card.front)}</h3>
        <div style="margin-top:15px;">
          <input type="text" id="testInput" placeholder="Type your answer..." />
          <div style="margin-top:10px;">
            <button class="btn primary" id="testSubmit">Submit</button>
          </div>
        </div>
        <div id="testFeedback" style="margin-top:15px;"></div>
      </div>
    `;

    $("#testSubmit").addEventListener("click", submit);
    $("#testInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }

  function submit() {
    if (!session.active) return;

    const input = $("#testInput");
    const feedback = $("#testFeedback");

    const userAnswer = input.value.trim();
    if (!userAnswer) return toast("Type an answer first.");

    const card = session.cards[session.index];

    const result = fuzzyCheck(card.back, userAnswer);

    session.answered++;

    if (result.ok) {
      session.correct++;
      feedback.innerHTML = `<div class="correct">Correct ✅</div>`;
    } else {
      feedback.innerHTML = `
        <div class="wrong">
          Incorrect ❌<br/>
          Correct answer: <strong>${escapeHtml(card.back)}</strong>
        </div>
      `;
    }

    updateStats();

    session.active = false;

    setTimeout(() => {
      session.index++;
      if (session.index >= session.cards.length) {
        endSession();
      } else {
        session.active = true;
        renderQuestion();
      }
    }, 1200);
  }

  function skip() {
    if (!session.active) return;

    session.index++;
    session.answered++;
    updateStats();

    if (session.index >= session.cards.length) {
      endSession();
    } else {
      renderQuestion();
    }
  }

  function endSession() {
    session.active = false;

    const finalScore = percent(session.correct, session.answered);

    el.stage.innerHTML = `
      <div class="card">
        <h3>Test complete 🎯</h3>
        <p>You scored <strong>${finalScore}%</strong></p>
        <button class="btn primary" id="testRestart">Restart</button>
      </div>
    `;

    $("#testRestart").addEventListener("click", start);
  }

  function updateStats() {
    el.score.textContent = percent(session.correct, session.answered) + "%";
    el.progress.textContent =
      `${session.index}/${session.cards.length}`;
  }

  function init() {
    if (!el.startBtn) return;

    fillSetSelect();

    el.startBtn.addEventListener("click", start);
    el.skipBtn.addEventListener("click", skip);

    bus.on("app:imported", fillSetSelect);
    bus.on("set:active", ({ setId }) => {
      fillSetSelect();
      if (setId) el.setSelect.value = setId;
    });

    updateStats();
  }

  bus.on("app:ready", init);
})();