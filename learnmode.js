/* ===============================
   GCSE Focus - learnmode.js
   MCQ Learn Mode Engine
   =============================== */
(() => {
  "use strict";

  const { $, shuffle, percent, escapeHtml, toast } = window.Utils;
  const { state, bus } = window.App;

  const el = {
    setSelect: $("#learnSetSelect"),
    startBtn: $("#btnLearnStart"),
    stage: $("#learnStage"),
    score: $("#learnScore"),
    progress: $("#learnProgress"),
  };

  let session = {
    setId: null,
    questions: [],
    index: 0,
    correct: 0,
    answered: 0,
    active: false,
  };

  function getMcqs(setId) {
    return (state.mcqBySet && state.mcqBySet[setId]) || [];
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

    const mcqs = getMcqs(setId);
    if (!mcqs.length) return toast("This set has no MCQs yet.");

    session = {
      setId,
      questions: shuffle(mcqs),
      index: 0,
      correct: 0,
      answered: 0,
      active: true,
    };

    renderQuestion();
    updateStats();
  }

  function renderQuestion() {
    const q = session.questions[session.index];
    if (!q) {
      el.stage.innerHTML = `<p class="muted">No questions found.</p>`;
      return;
    }

    el.stage.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(q.q)}</h3>
        <div style="margin-top:15px;">
          ${["A","B","C","D"].map(letter => `
            <button class="btn optionBtn" data-choice="${letter}">
              <strong>${letter}.</strong> ${escapeHtml(q.opts[letter])}
            </button>
          `).join("")}
        </div>
      </div>
    `;

    el.stage.querySelectorAll("[data-choice]").forEach(btn => {
      btn.addEventListener("click", () => answer(btn.dataset.choice));
    });
  }

  function answer(choice) {
    if (!session.active) return;

    const q = session.questions[session.index];
    const buttons = el.stage.querySelectorAll("[data-choice]");

    buttons.forEach(btn => btn.disabled = true);

    const correctLetter = q.correct;

    buttons.forEach(btn => {
      const letter = btn.dataset.choice;
      if (letter === correctLetter) {
        btn.classList.add("correct");
      }
      if (letter === choice && letter !== correctLetter) {
        btn.classList.add("wrong");
      }
    });

    if (choice === correctLetter) session.correct++;
    session.answered++;

    updateStats();

    setTimeout(() => {
      session.index++;
      if (session.index >= session.questions.length) {
        endSession();
      } else {
        renderQuestion();
      }
    }, 900);
  }

  function endSession() {
    session.active = false;

    const finalScore = percent(session.correct, session.answered);

    el.stage.innerHTML = `
      <div class="card">
        <h3>Session complete 🎉</h3>
        <p>You scored <strong>${finalScore}%</strong></p>
        <button class="btn primary" id="learnRestart">Restart</button>
      </div>
    `;

    $("#learnRestart").addEventListener("click", start);
  }

  function updateStats() {
    el.score.textContent = percent(session.correct, session.answered) + "%";
    el.progress.textContent =
      `${session.index}/${session.questions.length}`;
  }

  function init() {
    if (!el.startBtn) return;

    fillSetSelect();

    el.startBtn.addEventListener("click", start);

    bus.on("app:imported", fillSetSelect);
    bus.on("set:active", ({ setId }) => {
      fillSetSelect();
      if (setId) el.setSelect.value = setId;
    });

    updateStats();
  }

  bus.on("app:ready", init);
})();