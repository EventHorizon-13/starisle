const $ = (selector) => document.querySelector(selector);
const state = { data: null, selected: 0, requestId: 0 };
let moonSvgSequence = 0;
let sliderRenderFrame = 0;
let largeMoonAnimationFrame = 0;
let largeMoonCurrentPhase = null;
let largeMoonTargetPhase = null;
let largeMoonLastFrame = 0;
let largeMoonPulse = 0;
const mobileLayoutQuery = window.matchMedia("(max-width: 900px)");

function localMonthValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonthValue(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 1550 && year <= 2650 && month >= 1 && month <= 12 && !(year === 2650 && month > 1)
    ? { year, month } : null;
}

function dateOf(iso) {
  return new Date(`${iso}T12:00:00`);
}

function moonPhasePath(phase, steps = 48) {
  const angle = ((Number(phase) % 360) + 360) % 360;
  const radians = angle * Math.PI / 180;
  const limbSide = angle <= 180 ? 1 : -1;
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const value = -Math.PI / 2 + Math.PI * index / steps;
    points.push([50 + limbSide * Math.cos(value) * 42, 50 + Math.sin(value) * 42]);
  }
  for (let index = steps; index >= 0; index -= 1) {
    const value = -Math.PI / 2 + Math.PI * index / steps;
    points.push([50 + limbSide * Math.cos(radians) * Math.cos(value) * 42, 50 + Math.sin(value) * 42]);
  }
  return points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ") + " Z";
}

function moonPhaseSvg(phase, requestedId) {
  const path = moonPhasePath(phase);
  const id = requestedId || `moon-phase-${++moonSvgSequence}`;
  return `<svg class="moon-disc" viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <clipPath id="${id}-disc"><circle cx="50" cy="50" r="42"/></clipPath>
      <filter id="${id}-soft-edge" x="-12" y="-12" width="124" height="124" color-interpolation-filters="sRGB">
        <feGaussianBlur stdDeviation="0.72"/>
      </filter>
      <filter id="${id}-earthshine" x="0" y="0" width="100" height="100" color-interpolation-filters="sRGB">
        <feColorMatrix type="saturate" values="0.45"/>
        <feComponentTransfer>
          <feFuncR type="linear" slope="0.10"/>
          <feFuncG type="linear" slope="0.12"/>
          <feFuncB type="linear" slope="0.16"/>
        </feComponentTransfer>
      </filter>
      <radialGradient id="${id}-limb" cx="43%" cy="39%" r="58%">
        <stop offset="0" stop-color="#0a0d12" stop-opacity="0"/>
        <stop offset="68%" stop-color="#080b10" stop-opacity="0.08"/>
        <stop offset="88%" stop-color="#030508" stop-opacity="0.36"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.72"/>
      </radialGradient>
      <mask id="${id}-light" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <rect width="100" height="100" fill="#000"/>
        <path class="moon-light-shape" d="${path}" fill="#fff" filter="url(#${id}-soft-edge)"/>
      </mask>
    </defs>
    <circle cx="50" cy="50" r="42" fill="#05080c"/>
    <image class="moon-texture moon-texture-night" href="/moon-nasa-clementine.jpg" x="4" y="4" width="92" height="92" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}-disc)" filter="url(#${id}-earthshine)"/>
    <image class="moon-texture moon-texture-light" href="/moon-nasa-clementine.jpg" x="4" y="4" width="92" height="92" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}-disc)" mask="url(#${id}-light)"/>
    <circle cx="50" cy="50" r="42" fill="url(#${id}-limb)" clip-path="url(#${id}-disc)" pointer-events="none"/>
    <circle cx="50" cy="50" r="42" fill="none" stroke="#b9c3cf" stroke-opacity=".34" stroke-width=".55"/>
  </svg>`;
}

function renderLargeMoon(phase) {
  const host = $("#largeMoon");
  const lightShape = host.querySelector(".moon-light-shape");
  if (!lightShape) {
    host.innerHTML = moonPhaseSvg(phase, "selected-moon");
    largeMoonCurrentPhase = Number(phase);
    largeMoonTargetPhase = Number(phase);
    return;
  }
  largeMoonTargetPhase = Number(phase);
  if (!Number.isFinite(largeMoonCurrentPhase)) {
    largeMoonCurrentPhase = largeMoonTargetPhase;
    lightShape.setAttribute("d", moonPhasePath(largeMoonCurrentPhase));
    return;
  }
  const targetDelta = ((largeMoonTargetPhase - largeMoonCurrentPhase + 540) % 360) - 180;
  largeMoonPulse = Math.max(largeMoonPulse, Math.min(.048, .014 + Math.abs(targetDelta) * .0007));
  if (largeMoonAnimationFrame) return;
  largeMoonLastFrame = performance.now();
  const animateShape = (now) => {
    const elapsed = Math.min(48, now - largeMoonLastFrame);
    largeMoonLastFrame = now;
    const delta = ((largeMoonTargetPhase - largeMoonCurrentPhase + 540) % 360) - 180;
    const smoothing = 1 - Math.exp(-elapsed / 105);
    largeMoonCurrentPhase += delta * smoothing;
    largeMoonPulse *= Math.exp(-elapsed / 190);
    lightShape.setAttribute("d", moonPhasePath(largeMoonCurrentPhase, 30));
    const tilt = Math.max(-2.2, Math.min(2.2, delta * .045));
    host.style.transform = `scale(${(1 + largeMoonPulse).toFixed(4)}) rotate(${tilt.toFixed(3)}deg)`;
    if (Math.abs(delta) > .035 || largeMoonPulse > .0005) {
      largeMoonAnimationFrame = requestAnimationFrame(animateShape);
    } else {
      largeMoonCurrentPhase = largeMoonTargetPhase;
      lightShape.setAttribute("d", moonPhasePath(largeMoonCurrentPhase, 30));
      host.style.transform = "scale(1) rotate(0deg)";
      largeMoonAnimationFrame = 0;
    }
  };
  largeMoonAnimationFrame = requestAnimationFrame(animateShape);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function displayDay(date) {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date);
}

function displayEventTime(iso) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

function phaseCopy(day) {
  if (day.phase < 12 || day.phase > 348) return "月球接近太阳方向，夜空中的月面几乎不可见。";
  if (Math.abs(day.phase - 180) < 12) return "月面接近完全照亮，整夜都是较醒目的观测目标。";
  const trend = day.phase < 180 ? "逐日增加" : "逐日减少";
  return `月面照明正在${trend}；当天数据按设备所在时区的正午计算。`;
}

function renderSelected() {
  if (!state.data) return;
  const day = state.data.days[state.selected];
  const date = dateOf(day.date);
  $("#selectedWeekday").textContent = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(date);
  $("#selectedDate").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
  $("#selectedPhaseTag").textContent = Number.isFinite(day.age_days) ? `月龄 ${day.age_days.toFixed(1)} 天` : "月龄暂不可计算";
  renderLargeMoon(day.phase);
  $("#selectedPhaseName").textContent = day.phase_name;
  $("#selectedPhaseCopy").textContent = phaseCopy(day);
  $("#selectedIllumination").textContent = `${day.illumination.toFixed(1)}%`;
  $("#selectedDistance").textContent = `${Math.round(day.distance_km).toLocaleString("zh-CN")} km`;
  $("#daySlider").value = String(state.selected);
  $("#sliderCurrent").textContent = displayDay(date);
  document.querySelectorAll(".day-cell").forEach((cell) => cell.classList.toggle("selected", Number(cell.dataset.index) === state.selected));
}

function renderEvents() {
  const list = $("#eventList");
  const phaseAngles = [0, 90, 180, 270];
  if (!state.data.events.length) {
    list.innerHTML = '<p class="events-note">本月没有主要月相节点。</p>';
    return;
  }
  list.innerHTML = state.data.events.map((event) => `
    <div class="phase-event">
      <div class="event-moon">${moonPhaseSvg(phaseAngles[event.type])}</div>
      <div><strong>${event.name}</strong><span>${displayEventTime(event.time)}</span></div>
    </div>`).join("");
}

function renderCalendar() {
  const first = dateOf(state.data.days[0].date);
  const offset = (first.getDay() + 6) % 7;
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const events = new Map(state.data.events.map((event) => [event.local_date, event.name]));
  const blanks = Array.from({ length: offset }, () => '<div class="calendar-empty" aria-hidden="true"></div>');
  const days = state.data.days.map((day, index) => {
    const date = dateOf(day.date);
    const event = events.get(day.date);
    return `<button type="button" class="day-cell${day.date === todayIso ? " today" : ""}${index === state.selected ? " selected" : ""}" data-index="${index}" aria-label="${displayDay(date)}，${day.phase_name}，照明 ${day.illumination}%">
      <span class="day-number">${date.getDate()}</span>
      <div class="day-moon">${moonPhaseSvg(day.phase)}</div>
      <span class="day-info"><span>${day.phase_name}</span><span>${Math.round(day.illumination)}%</span></span>
      ${event ? `<span class="day-event">${event}</span>` : ""}
    </button>`;
  });
  $("#calendarGrid").innerHTML = [...blanks, ...days].join("");
  document.querySelectorAll(".day-cell").forEach((cell) => cell.addEventListener("click", () => {
    state.selected = Number(cell.dataset.index);
    renderSelected();
    if (window.innerWidth <= 700) $(".moon-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function render() {
  const monthDate = new Date(state.data.year, state.data.month - 1, 1);
  const monthText = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(monthDate);
  $("#calendarTitle").textContent = monthText;
  $("#eventMonth").textContent = monthText;
  $("#daySlider").max = String(state.data.days.length - 1);
  $("#sliderStart").textContent = "1 日";
  $("#sliderEnd").textContent = `${state.data.days.length} 日`;
  renderCalendar();
  renderEvents();
  renderSelected();
}

async function loadMonth({ selectToday = false } = {}) {
  const parsed = parseMonthValue($("#monthInput").value);
  if (!parsed) {
    showToast("请选择有效月份。");
    return;
  }
  const { year, month } = parsed;
  $("#monthInput").value = `${year}-${String(month).padStart(2, "0")}`;
  const requestId = ++state.requestId;
  $("#loadStatus").textContent = "正在计算…";
  try {
    const params = new URLSearchParams({
      year: String(year), month: String(month), utc_offset: String(-new Date().getTimezoneOffset()),
    });
    const response = await fetch(`/api/moon-calendar?${params}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "月相日历载入失败。");
    if (requestId !== state.requestId) return;
    state.data = data;
    const today = new Date();
    state.selected = selectToday && today.getFullYear() === year && today.getMonth() + 1 === month ? today.getDate() - 1 : 0;
    $("#loadStatus").textContent = "星历已就绪";
    render();
  } catch (error) {
    if (requestId !== state.requestId) return;
    $("#loadStatus").textContent = "载入失败";
    showToast(error.message || "月相日历载入失败。");
  }
}

function changeMonth(delta) {
  const parsed = parseMonthValue($("#monthInput").value);
  if (!parsed) return;
  const { year, month } = parsed;
  const next = new Date(year, month - 1 + delta, 1);
  const value = localMonthValue(next);
  if (next.getFullYear() < 1550 || next.getFullYear() > 2650) return;
  $("#monthInput").value = value;
  loadMonth();
}

function syncEventPanelPlacement(query = mobileLayoutQuery) {
  const eventsPanel = $(".events-panel");
  const moonLayout = $(".moon-layout");
  const calendarPanel = $(".calendar-panel");
  if (query.matches) calendarPanel.insertAdjacentElement("afterend", eventsPanel);
  else moonLayout.append(eventsPanel);
}

function bindEvents() {
  if (mobileLayoutQuery.addEventListener) mobileLayoutQuery.addEventListener("change", syncEventPanelPlacement);
  else mobileLayoutQuery.addListener(syncEventPanelPlacement);
  $("#monthInput").addEventListener("change", () => loadMonth());
  $("#prevMonthBtn").addEventListener("click", () => changeMonth(-1));
  $("#nextMonthBtn").addEventListener("click", () => changeMonth(1));
  $("#thisMonthBtn").addEventListener("click", () => {
    $("#monthInput").value = localMonthValue(new Date());
    loadMonth({ selectToday: true });
  });
  $("#daySlider").addEventListener("input", (event) => {
    if (!state.data) return;
    state.selected = Number(event.target.value);
    cancelAnimationFrame(sliderRenderFrame);
    sliderRenderFrame = requestAnimationFrame(renderSelected);
  });
}

function init() {
  $("#monthInput").value = localMonthValue(new Date());
  syncEventPanelPlacement();
  bindEvents();
  loadMonth({ selectToday: true });
}

init();
