/* ===============================
   GCSE Focus - tasks.js
   Tasks: add/complete/delete/repeat + filter/search + 7d completion %
   =============================== */
(() => {
  "use strict";

  const { $, $$, uid, todayISO, dateToMs, escapeHtml, toast, percent } = window.Utils;
  const { state, save, bus } = window.App;

  // --- Elements ---
  const el = {
    name: $("#taskName"),
    subject: $("#taskSubject"),
    due: $("#taskDue"),
    priority: $("#taskPriority"),
    repeat: $("#taskRepeat"),
    addBtn: $("#btnAddTask"),
    clearDoneBtn: $("#btnClearDoneTasks"),
    filter: $("#taskFilter"),
    search: $("#taskSearch"),
    count: $("#taskCount"),
    list: $("#taskList"),
    completion: $("#uiCompletion"),
  };

  // --- Helpers ---
  function dueInfo(dueISO) {
    if (!dueISO) return { text: "No due date", tone: "muted" };
    const t = dateToMs(todayISO());
    const d = dateToMs(dueISO);
    const diff = Math.round((d - t) / (24 * 3600 * 1000));
    if (diff === 0) return { text: "Due today", tone: "warn" };
    if (diff === 1) return { text: "Due tomorrow", tone: "warn" };
    if (diff < 0) return { text: `Overdue (${Math.abs(diff)}d)`, tone: "bad" };
    return { text: `Due in ${diff}d`, tone: "good" };
  }

  function priorityLabel(p) {
    if (p === "high") return "High";
    if (p === "med") return "Medium";
    return "Low";
  }

  function matchesFilter(task) {
    const f = el.filter.value;
    const today = todayISO();

    if (f === "all") return true;
    if (f === "done") return !!task.done;
    if (f === "todo") return !task.done;
    if (f === "high") return task.priority === "high" && !task.done;
    if (f === "today") return !task.done && task.due === today;
    if (f === "overdue") {
      if (task.done) return false;
      if (!task.due) return false;
      return dateToMs(task.due) < dateToMs(today);
    }
    return true;
  }

  function matchesSearch(task) {
    const q = (el.search.value || "").trim().toLowerCase();
    if (!q) return true;
    return (
      (task.name || "").toLowerCase().includes(q) ||
      (task.subject || "").toLowerCase().includes(q)
    );
  }

  // --- Core actions ---
  function addTask() {
    const name = (el.name.value || "").trim();
    if (!name) return toast("Type a task first.");

    const t = {
      id: uid(),
      name,
      subject: el.subject.value || "Other",
      due: el.due.value || null,
      priority: el.priority.value || "med",
      repeat: el.repeat.value || "none", // none|daily|weekly
      done: false,
      createdAt: Date.now(),
      doneAt: null,
    };

    state.tasks.unshift(t);
    save();
    el.name.value = "";
    render();
    renderCompletion7d();
    toast("Task added.");
  }

  function toggleDone(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;

    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : null;

    // If repeating and completed, spawn next instance
    if (t.done && t.repeat && t.repeat !== "none") {
      const next = { ...t, id: uid(), done: false, doneAt: null, createdAt: Date.now() };

      if (t.due) {
        const dt = new Date(t.due + "T00:00:00");
        dt.setDate(dt.getDate() + (t.repeat === "daily" ? 1 : 7));
        next.due = dt.toISOString().slice(0, 10);
      }
      state.tasks.unshift(next);
    }

    save();
    render();
    renderCompletion7d();
    bus.emit("stats:changed", {});
  }

  function deleteTask(id) {
    state.tasks = state.tasks.filter((x) => x.id !== id);
    save();
    render();
    renderCompletion7d();
    toast("Task removed.");
  }

  function clearDone() {
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((t) => !t.done);
    const removed = before - state.tasks.length;
    save();
    render();
    renderCompletion7d();
    toast(removed ? `Cleared ${removed} done task(s).` : "No completed tasks to clear.");
  }

  // --- Rendering ---
  function render() {
    if (!el.list) return;

    el.count.textContent = String(state.tasks.length);

    const filtered = state.tasks.filter(matchesFilter).filter(matchesSearch);

    el.list.innerHTML = "";
    if (filtered.length === 0) {
      el.list.innerHTML = `<div class="muted small">No tasks here yet. Add one on the left ✨</div>`;
      return;
    }

    filtered.forEach((t) => {
      const due = dueInfo(t.due);
      const wrapper = document.createElement("div");
      wrapper.className = "listItem";

      const left = document.createElement("div");
      left.style.display = "flex";
      left.style.gap = "10px";
      left.style.alignItems = "flex-start";
      left.style.flex = "1";
      left.style.minWidth = "0";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = !!t.done;
      check.style.marginTop = "4px";
      check.addEventListener("change", () => toggleDone(t.id));

      const text = document.createElement("div");
      text.style.minWidth = "0";

      const title = document.createElement("div");
      title.style.fontWeight = "700";
      title.style.whiteSpace = "nowrap";
      title.style.overflow = "hidden";
      title.style.textOverflow = "ellipsis";
      title.innerHTML = escapeHtml(t.name);
      if (t.done) {
        title.style.textDecoration = "line-through";
        title.style.opacity = "0.7";
      }

      const meta = document.createElement("div");
      meta.className = "muted small";
      meta.style.display = "flex";
      meta.style.gap = "10px";
      meta.style.flexWrap = "wrap";
      meta.style.marginTop = "4px";

      const subj = document.createElement("span");
      subj.textContent = `📚 ${t.subject}`;

      const pr = document.createElement("span");
      pr.textContent = `⚑ ${priorityLabel(t.priority)}`;

      const dd = document.createElement("span");
      dd.textContent = `📅 ${due.text}`;

      const rep = document.createElement("span");
      rep.textContent = t.repeat !== "none" ? `🔁 ${t.repeat}` : "";

      meta.appendChild(subj);
      meta.appendChild(pr);
      meta.appendChild(dd);
      if (rep.textContent) meta.appendChild(rep);

      text.appendChild(title);
      text.appendChild(meta);

      left.appendChild(check);
      left.appendChild(text);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "8px";
      right.style.alignItems = "center";

      const del = document.createElement("button");
      del.className = "btn";
      del.type = "button";
      del.textContent = "🗑";
      del.title = "Delete";
      del.addEventListener("click", () => deleteTask(t.id));

      right.appendChild(del);

      wrapper.appendChild(left);
      wrapper.appendChild(right);

      el.list.appendChild(wrapper);
    });
  }

  // --- 7-day completion rate (for right panel UI) ---
  function completionRate7d() {
    const now = Date.now();
    const seven = 7 * 24 * 3600 * 1000;
    const recent = state.tasks.filter((t) => (now - (t.createdAt || now)) <= seven);
    if (recent.length === 0) return 0;
    const done = recent.filter((t) => !!t.done).length;
    return percent(done, recent.length);
  }

  function renderCompletion7d() {
    if (!el.completion) return;
    el.completion.textContent = `${completionRate7d()}%`;
  }

  // --- Wiring ---
  function init() {
    if (!el.addBtn) return;

    // Default due date
    el.due.value = el.due.value || todayISO();

    el.addBtn.addEventListener("click", addTask);
    el.clearDoneBtn.addEventListener("click", clearDone);
    el.filter.addEventListener("change", render);
    el.search.addEventListener("input", render);

    el.name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addTask();
      }
    });

    // When app imports or subjects refresh, re-render safely
    bus.on("app:imported", () => {
      el.due.value = el.due.value || todayISO();
      render();
      renderCompletion7d();
    });

    bus.on("subjects:ready", () => {
      // nothing needed here; select already updated by app.js
    });

    // Initial render
    render();
    renderCompletion7d();
  }

  // boot when app is ready
  bus.on("app:ready", init);
})();