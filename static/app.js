const $ = (selector) => document.querySelector(selector);
// 事件绑定容错：某个元素缺失时不再中断整段初始化。
function on(selector, type, handler, options) {
  const node = $(selector);
  if (node) node.addEventListener(type, handler, options);
  else console.warn("页面元素缺失：", selector);
  return node;
}
const state = {
  sky: null,
  location: null,
  selected: null,
  pendingInstall: null,
  refreshTimer: null,
  skySeq: 0,
  skyAbort: null,
  eventsSeq: 0,
  fieldSeq: 0,
  searchSeq: 0,
  fieldTimer: null,
  fieldAbort: null,
  searchTimer: null,
  searchResults: [],
  field: { stars: [], deep_sky: [], loading: false },
  catalogTargets: new Map(),
  deepSkyMarkers: [],
  deepSkyLabels: [],
  trail: { on: false, halfHours: 12, data: null, loading: false, seq: 0, abort: null },
  timeline: {
    centerMs: null,
    mode: "hour",
    daySpan: 30,
    scrub: null,
    solarSamples: new Map(),
    previewKey: "",
    previewRequestKey: "",
    previewSeq: 0,
    previewAbort: null,
    previewLoading: false,
    inputFrame: 0,
    pendingValue: null,
  },
  satellites: { enabled: new Set([48274]), data: null, catalog: [], seq: 0, abort: null, error: "", retry: null, passesSeq: 0 },
};

const canvas = $("#skyCanvas");
const ctx = canvas.getContext("2d");
let skyDrawFrame = 0;
let starDrawingCache = null;
let starLayerCache = null;

function requestSkyDraw() {
  if (skyDrawFrame) return;
  skyDrawFrame = requestAnimationFrame(() => {
    skyDrawFrame = 0;
    drawSky();
  });
}
const SYNODIC_MONTH_DAYS = 29.530588;
const nameCollator = new Intl.Collator("zh-CN");
const clockFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const datedClockFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const cardinal16 = ["北", "北东北", "东北", "东东北", "东", "东东南", "东南", "南东南", "南", "南西南", "西南", "西西南", "西", "西西北", "西北", "北西北"];
const glyphs = {
  sun: "☼", moon: "☾", mercury: "☿", venus: "♀", mars: "♂",
  jupiter: "♃", saturn: "♄", uranus: "♅", neptune: "♆", pluto: "♇",
};
const constellationLines = [
  ["大熊座", [54061, 53910, 58001, 59774, 62956, 65378, 67301, 62956]],
  ["仙后座", [746, 3179, 4427, 6686, 8886]],
  ["猎户座", [27989, 25336, 25930, 26311, 26727, 25930, 24436, 27366, 26727]],
  ["天鹅座", [102098, 100453, 102488, 104060, 95947, 100453]],
  ["狮子座", [49669, 50583, 54872, 57632, 54879, 49669]],
  ["天蝎座", [80763, 78401, 78820, 79374, 80463, 82396, 85696, 85927, 86228]],
];

function localInputValue(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 19);
}

function parseLocalInput(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map((part) => Number(part || 0));
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
      || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
  if (year < 1550 || date > new Date(2650, 0, 25, 23, 59, 59)) return null;
  return date;
}

function selectedDate() {
  return parseLocalInput($("#timeInput").value) || new Date();
}

function skyTimeIso() {
  return selectedDate().toISOString();
}

function coords() {
  if (state.location) return state.location;
  return { lat: 0, lon: 0, elevation: 0, sample: true };
}

function azimuthOf(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function azimuthCompass(value) {
  return cardinal16[Math.round(azimuthOf(value) / 22.5) % 16];
}

function formatAzimuth(value) {
  return `${azimuthOf(value).toFixed(1)}° ${azimuthCompass(value)}`;
}

function formatAltitude(value) {
  const alt = Number(value);
  return `${alt >= 0 ? "+" : "−"}${Math.abs(alt).toFixed(1)}°`;
}

function formatMagnitude(value) {
  return Number(value).toFixed(2).replace("-", "−");
}

function glyphOf(target) {
  if (!target) return "✦";
  if (target.kind === "人造天体") return "◇";
  if (glyphs[target.id]) return glyphs[target.id];
  if (target.catalog?.startsWith("M")) return "◇";
  return target.kind === "恒星" ? "✦" : "◉";
}

// 根据日月黄经差生成真实盈亏形状：0° 新月、90° 上弦、180° 满月、270° 下弦。
function moonPhaseSvg(phase) {
  const angle = ((Number(phase) % 360) + 360) % 360;
  const radians = angle * Math.PI / 180;
  const limbSide = angle <= 180 ? 1 : -1;
  const points = [];
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    const a = -Math.PI / 2 + Math.PI * i / steps;
    points.push([12 + limbSide * Math.cos(a) * 9, 12 + Math.sin(a) * 9]);
  }
  for (let i = steps; i >= 0; i -= 1) {
    const a = -Math.PI / 2 + Math.PI * i / steps;
    points.push([12 + limbSide * Math.cos(radians) * Math.cos(a) * 9, 12 + Math.sin(a) * 9]);
  }
  const path = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ") + " Z";
  return `<svg class="moon-phase-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#252b32"/><path d="${path}" fill="#e7e7df"/><circle cx="12" cy="12" r="9" fill="none" stroke="#aeb5b7" stroke-width="0.8"/></svg>`;
}

// 暮光阶段按太阳高度划分：0° 以下依次为民用（−6°）、航海（−12°）、天文（−18°）暮光。
function twilightInfo(sunAltitude) {
  const alt = Number(sunAltitude);
  if (alt > 0) return { label: "白昼", dark: false };
  if (alt > -6) return { label: "民用暮光", dark: false };
  if (alt > -12) return { label: "航海暮光", dark: false };
  if (alt > -18) return { label: "天文暮光", dark: false };
  return { label: "天文暮光已结束", dark: true };
}

function displayClock(iso, withDate = false) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return (withDate ? datedClockFormat : clockFormat).format(date);
}

function timelineBounds() {
  const selectedMs = selectedDate().getTime();
  const center = Number.isFinite(state.timeline.centerMs) ? state.timeline.centerMs : selectedMs;
  if (state.timeline.mode === "day") {
    return {
      center,
      start: addLocalDays(new Date(center), -state.timeline.daySpan).getTime(),
      end: addLocalDays(new Date(center), state.timeline.daySpan).getTime(),
    };
  }
  const halfMs = state.trail.halfHours * 60 * 60 * 1000;
  return { center, start: center - halfMs, end: center + halfMs };
}

function addLocalDays(date, days) {
  const shifted = new Date(date.getTime());
  shifted.setDate(shifted.getDate() + Number(days));
  return shifted;
}

function localDayOffset(from, to) {
  const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toDay - fromDay) / 86400000);
}

function timelineDateAtOffset(center, offset) {
  return state.timeline.mode === "day"
    ? addLocalDays(new Date(center), offset)
    : new Date(center + offset * 60000);
}

function timelineLabel(date) {
  return datedClockFormat.format(date);
}

function dailyPreviewDates(center) {
  const dates = [];
  for (let offset = -state.timeline.daySpan; offset <= state.timeline.daySpan; offset += 1) {
    dates.push(addLocalDays(new Date(center), offset));
  }
  return dates;
}

function timelinePreviewDates(center) {
  if (state.timeline.mode === "day") return dailyPreviewDates(center);
  const dates = [];
  const halfMinutes = state.trail.halfHours * 60;
  for (let offset = -halfMinutes; offset <= halfMinutes; offset += 15) {
    dates.push(new Date(center + offset * 60000));
  }
  return dates;
}

function timelineSolarSample(date) {
  const ms = date.getTime();
  const samples = state.timeline.solarSamples;
  if (samples.has(ms)) return samples.get(ms);
  if (state.timeline.mode !== "hour") return null;
  const center = timelineBounds().center;
  const beforeMs = center + Math.floor((ms - center) / 900000) * 900000;
  const before = samples.get(beforeMs);
  const after = samples.get(beforeMs + 900000);
  if (!before || !after) return null;
  const weight = (ms - beforeMs) / 900000;
  const afterById = new Map(after.objects.map((item) => [item.id, item]));
  const objects = before.objects.map((item) => {
    const next = afterById.get(item.id);
    const vector = (point) => {
      const alt = point.altitude * Math.PI / 180;
      const az = point.azimuth * Math.PI / 180;
      return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
    };
    const a = vector(item), b = vector(next);
    const [east, north, up] = a.map((value, index) => value * (1 - weight) + b[index] * weight);
    const altitude = Math.atan2(up, Math.hypot(east, north)) * 180 / Math.PI;
    const result = { ...item, altitude, azimuth: azimuthOf(Math.atan2(east, north) * 180 / Math.PI), above_horizon: altitude > 0 };
    if (Number.isFinite(item.magnitude) && Number.isFinite(next.magnitude)) result.magnitude = item.magnitude + (next.magnitude - item.magnitude) * weight;
    if (item.id === "moon") {
      result.phase = azimuthOf(item.phase + ((next.phase - item.phase + 540) % 360 - 180) * weight);
      result.illumination = item.illumination + (next.illumination - item.illumination) * weight;
    }
    return result;
  });
  return { time: date.toISOString(), objects, sun_altitude: objects.find((item) => item.id === "sun")?.altitude };
}

function invalidateTimelinePreview() {
  state.timeline.previewSeq += 1;
  state.timeline.previewAbort?.abort();
  state.timeline.previewAbort = null;
  state.timeline.previewKey = "";
  state.timeline.previewRequestKey = "";
  state.timeline.previewLoading = false;
  state.timeline.solarSamples = new Map();
}

async function loadTimelinePreview() {
  if (!state.location || !Number.isFinite(state.timeline.centerMs)) return;
  const loc = coords();
  const dates = timelinePreviewDates(state.timeline.centerMs).filter((date) => {
    const ms = date.getTime();
    return ms >= Date.parse("1550-01-01T00:00:00Z") && ms < Date.parse("2650-01-26T00:00:00Z");
  });
  const times = dates.map((date) => date.toISOString());
  const key = [loc.lat, loc.lon, loc.elevation || 0, ...times].join("|");
  if (state.timeline.previewKey === key && state.timeline.solarSamples.size === times.length) return;
  if (state.timeline.previewLoading && state.timeline.previewRequestKey === key) return;

  const seq = ++state.timeline.previewSeq;
  state.timeline.previewAbort?.abort();
  const controller = new AbortController();
  state.timeline.previewAbort = controller;
  state.timeline.previewRequestKey = key;
  state.timeline.previewLoading = true;
  renderTimeSlider();
  try {
    const response = await fetch("/api/timeline-preview", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: loc.lat,
        lon: loc.lon,
        elevation: loc.elevation || 0,
        times,
      }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "按天预览载入失败。");
    if (seq !== state.timeline.previewSeq) return;
    state.timeline.solarSamples = new Map((data.samples || []).map((sample) => [new Date(sample.time).getTime(), sample]));
    state.timeline.previewKey = key;
    if (state.timeline.scrub) previewTimeline(selectedDate());
  } catch (error) {
    if (seq === state.timeline.previewSeq && error.name !== "AbortError") {
      console.warn(error);
      showToast("暂时无法准备精确时间预览。");
    }
  } finally {
    if (seq === state.timeline.previewSeq) {
      state.timeline.previewLoading = false;
      state.timeline.previewAbort = null;
      renderTimeSlider();
    }
  }
}

function renderTimeSlider() {
  const slider = $("#timeSlider");
  if (!slider) return;
  const { center, start, end } = timelineBounds();
  const daily = state.timeline.mode === "day";
  const limit = daily ? state.timeline.daySpan : state.trail.halfHours * 60;
  const rawOffset = daily
    ? localDayOffset(new Date(center), selectedDate())
    : Math.round((selectedDate().getTime() - center) / 60000);
  const offset = Math.max(-limit, Math.min(limit, rawOffset));
  const current = timelineDateAtOffset(center, offset);
  slider.min = String(-limit);
  slider.max = String(limit);
  slider.step = "1";
  slider.value = String(offset);
  slider.disabled = state.timeline.previewLoading && state.timeline.solarSamples.size === 0;
  slider.setAttribute("aria-label", daily ? "按天查看每天同一时刻的星图" : "按小时调整观测时间");
  $("#timeSliderStart").textContent = timelineLabel(new Date(start));
  $("#timeSliderCurrent").textContent = timelineLabel(current);
  $("#timeSliderEnd").textContent = timelineLabel(new Date(end));
  const dayRelation = offset === 0 ? "中心日期" : `中心日期${offset < 0 ? "前" : "后"} ${Math.abs(offset)} 天`;
  slider.setAttribute("aria-valuetext", daily ? `${timelineLabel(current)}，${dayRelation}` : timelineLabel(current));
}

function resetTimeline(date = selectedDate()) {
  cancelAnimationFrame(state.timeline.inputFrame);
  state.timeline.inputFrame = 0;
  state.timeline.pendingValue = null;
  const centerChanged = state.timeline.centerMs !== date.getTime();
  if (centerChanged) invalidateTimelinePreview();
  state.timeline.centerMs = date.getTime();
  state.timeline.scrub = null;
  renderTimeSlider();
  if (state.timeline.mode === "day") loadTimelinePreview();
}

function setTimelineMode(mode) {
  if (!["hour", "day"].includes(mode) || state.timeline.mode === mode) return;
  state.timeline.mode = mode;
  document.querySelectorAll("#timelineMode [data-mode]").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  resetTimeline(selectedDate());
  loadTimelinePreview();
  if (state.trail.on) loadTrails();
  showToast(mode === "day" ? "时间轴已切换为每天同一时刻（±30 天）。" : "时间轴已切换为小时模式。");
}

function horizontalBasis(item, latitude) {
  const altitude = Number(item.altitude) * Math.PI / 180;
  const azimuth = Number(item.azimuth) * Math.PI / 180;
  const cosAltitude = Math.cos(altitude);
  const east = cosAltitude * Math.sin(azimuth);
  const north = cosAltitude * Math.cos(azimuth);
  const up = Math.sin(altitude);
  return {
    sinDeclination: north * Math.cos(latitude) + up * Math.sin(latitude),
    hourX: up * Math.cos(latitude) - north * Math.sin(latitude),
    hourY: -east,
  };
}

function beginTimelineScrub() {
  if (state.timeline.scrub || !state.sky) return;
  // 正在返回的旧时间请求不能覆盖拖动预览。
  state.skySeq += 1;
  state.skyAbort?.abort();
  state.eventsSeq += 1;
  state.fieldSeq += 1;
  state.fieldAbort?.abort();
  state.searchSeq += 1;
  clearTimeout(state.fieldTimer);
  clearTimeout(state.searchTimer);
  $("#eventsResult").hidden = true;
  $("#searchResults").hidden = true;
  if (state.timeline.mode === "day") invalidateTrails();
  invalidateSatellites();
  $("#loadingOverlay").hidden = true;
  const latitude = Number(coords().lat) * Math.PI / 180;
  const objects = state.sky.objects.map((item) => ({ ...item }));
  const stars = state.sky.stars.map((item) => ({ ...item }));
  const messier = (state.sky.messier || []).map((item) => ({ ...item }));
  const milkyWay = (state.sky.milky_way || []).map((item) => ({ ...item }));
  const preview = { ...state.sky, objects, stars, messier, milky_way: milkyWay };
  preview.moon = objects.find((item) => item.id === "moon") || null;
  state.timeline.scrub = {
    sourceTimeMs: new Date(state.sky.requested_time).getTime(),
    sourceMoonPhase: Number(state.sky.moon?.phase),
    latitude,
    preview,
    objectBasis: state.sky.objects.map((item) => horizontalBasis(item, latitude)),
    starBasis: state.sky.stars.map((item) => horizontalBasis(item, latitude)),
    messierBasis: (state.sky.messier || []).map((item) => horizontalBasis(item, latitude)),
    milkyWayBasis: (state.sky.milky_way || []).map((item) => horizontalBasis(item, latitude)),
  };
}

function projectTimelineItems(previewItems, bases, sinLatitude, cosLatitude, cosine, sine) {
  let visible = 0;
  for (let index = 0; index < previewItems.length; index += 1) {
    const basis = bases[index];
    const hourX = basis.hourX * cosine - basis.hourY * sine;
    const hourY = basis.hourY * cosine + basis.hourX * sine;
    const east = -hourY;
    const north = basis.sinDeclination * cosLatitude - hourX * sinLatitude;
    const up = Math.max(-1, Math.min(1, basis.sinDeclination * sinLatitude + hourX * cosLatitude));
    const target = previewItems[index];
    target.altitude = Math.asin(up) * 180 / Math.PI;
    target.azimuth = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
    target.above_horizon = target.altitude > 0;
    if (target.above_horizon) visible += 1;
  }
  return visible;
}

function previewTimeline(date) {
  const scrub = state.timeline.scrub;
  if (!scrub) return;
  // Stars rotate by sidereal time; preloaded JPL samples include solar-body motion.
  const angle = (date.getTime() - scrub.sourceTimeMs) / 3600000 * 15 * 1.00273790935 * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const sinLatitude = Math.sin(scrub.latitude);
  const cosLatitude = Math.cos(scrub.latitude);
  projectTimelineItems(scrub.preview.objects, scrub.objectBasis, sinLatitude, cosLatitude, cosine, sine);
  scrub.preview.visible_star_count = projectTimelineItems(
    scrub.preview.stars, scrub.starBasis, sinLatitude, cosLatitude, cosine, sine,
  );
  scrub.preview.visible_messier_count = projectTimelineItems(
    scrub.preview.messier, scrub.messierBasis, sinLatitude, cosLatitude, cosine, sine,
  );
  projectTimelineItems(
    scrub.preview.milky_way, scrub.milkyWayBasis, sinLatitude, cosLatitude, cosine, sine,
  );
  const solarSample = timelineSolarSample(date);
  if (solarSample) {
    const byId = new Map(solarSample.objects.map((item) => [item.id, item]));
    scrub.preview.objects.forEach((item) => {
      const exact = byId.get(item.id);
      if (exact) Object.assign(item, exact);
    });
  }
  const sun = scrub.preview.objects.find((item) => item.id === "sun");
  const moon = scrub.preview.moon;
  if (!solarSample && moon && Number.isFinite(scrub.sourceMoonPhase)) {
    const elapsedDays = (date.getTime() - scrub.sourceTimeMs) / 86400000;
    moon.phase = ((scrub.sourceMoonPhase + elapsedDays * 360 / SYNODIC_MONTH_DAYS) % 360 + 360) % 360;
    moon.illumination = (1 - Math.cos(moon.phase * Math.PI / 180)) * 50;
    const phaseAngle = Math.abs(180 - moon.phase);
    moon.magnitude = -12.73 + .026 * phaseAngle + 4e-9 * phaseAngle ** 4;
  }
  scrub.preview.sun_altitude = solarSample?.sun_altitude ?? (sun ? sun.altitude : scrub.preview.sun_altitude);
  scrub.preview.requested_time = date.toISOString();
  state.sky = scrub.preview;
  renderSky();
  if (state.selected) renderSelection();
}

function queueTimelineInput(value) {
  beginTimelineScrub();
  state.timeline.pendingValue = value;
  if (state.timeline.inputFrame) return;
  state.timeline.inputFrame = requestAnimationFrame(() => {
    state.timeline.inputFrame = 0;
    const pending = state.timeline.pendingValue;
    state.timeline.pendingValue = null;
    setTimeFromSlider(pending);
  });
}

function setTimeFromSlider(value) {
  beginTimelineScrub();
  const { center } = timelineBounds();
  const date = timelineDateAtOffset(center, Number(value));
  $("#timeInput").value = localInputValue(date);
  renderTimeSlider();
  previewTimeline(date);
}

function finishTimelineScrub() {
  cancelAnimationFrame(state.timeline.inputFrame);
  state.timeline.inputFrame = 0;
  const pending = state.timeline.pendingValue;
  state.timeline.pendingValue = null;
  if (pending !== null) setTimeFromSlider(pending);
  state.timeline.scrub = null;
  clearTimeout(state.refreshTimer);
  refreshSky({ reloadTrails: state.timeline.mode === "day", showLoading: false });
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2700);
}

function setStatus(text, good = true) {
  const status = $("#jsStatus");
  if (status && !good) status.textContent = text;
}

function updateLocationLabel() {
  const loc = coords();
  const lat = `${Math.abs(loc.lat).toFixed(3)}° ${loc.lat < 0 ? "S" : "N"}`;
  const lon = `${Math.abs(loc.lon).toFixed(3)}° ${loc.lon < 0 ? "W" : "E"}`;
  $("#locationLabel").textContent = `${loc.sample ? "未定位 · " : ""}${lat} · ${lon}`;
}

function setManualOpen(open) {
  $("#manualBlock").hidden = !open;
  $("#manualToggleBtn").setAttribute("aria-expanded", String(open));
}

function saveLocation() {
  if (!state.location) return;
  localStorage.setItem("night-sky-location", JSON.stringify(state.location));
}

function setLocation(lat, lon, elevation = 0) {
  const next = { lat: Number(lat), lon: Number(lon), elevation: Number(elevation) || 0 };
  const changed = !state.location || state.location.lat !== next.lat || state.location.lon !== next.lon
    || state.location.elevation !== next.elevation;
  state.location = next;
  if (changed) invalidateTimelinePreview();
  $("#latInput").value = state.location.lat.toFixed(4);
  $("#lonInput").value = state.location.lon.toFixed(4);
  $("#elevationInput").value = String(Math.round(state.location.elevation));
  updateLocationLabel();
  saveLocation();
}

async function locateUser(silent = false) {
  if (!navigator.geolocation) {
    if (!silent) showToast("此浏览器暂不支持定位，请手动输入经纬度。");
    return false;
  }
  $("#locateBtn").classList.add("busy");
  try {
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 300000,
    }));
    // 首次自动定位期间用户可能已手动设置地点，保留用户的选择。
    if (silent && state.location) return false;
    setLocation(position.coords.latitude, position.coords.longitude, position.coords.altitude || coords().elevation || 0);
    if (!silent) showToast("已使用手机定位更新观测地点。");
    return true;
  } catch (error) {
    if (!silent) showToast(error.code === 1 ? "定位权限未开启，可手动输入经纬度。" : "暂时无法定位，请手动输入经纬度。");
    return false;
  } finally {
    $("#locateBtn").classList.remove("busy");
  }
}

function buildUrl(path, params) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url;
}

async function refreshSky({ keepSelection = true, reloadTrails = true, showLoading = true } = {}) {
  const loc = coords();
  const timeValue = $("#timeInput").value;
  if (!timeValue) return;
  state.eventsSeq += 1;
  state.fieldSeq += 1;
  state.fieldAbort?.abort();
  state.searchSeq += 1;
  clearTimeout(state.fieldTimer);
  clearTimeout(state.searchTimer);
  $("#eventsResult").hidden = true;
  $("#searchResults").hidden = true;
  if (reloadTrails) invalidateTrails();
  invalidateSatellites();
  loadSatellites();
  const seq = ++state.skySeq;
  state.skyAbort?.abort();
  const controller = new AbortController();
  state.skyAbort = controller;
  $("#loadingOverlay").hidden = !showLoading;
  if (showLoading) {
    $("#loadingOverlay").hidden = false;
    $("#loadingOverlay").style.opacity = "1";
  }
  const query = {
    lat: loc.lat,
    lon: loc.lon,
    elevation: loc.elevation || 0,
    datetime: skyTimeIso(),
  };
  try {
    const response = await fetch(buildUrl("/api/sky", query), { cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "天象计算失败。");
    if (seq !== state.skySeq) return;
    state.sky = data;
    state.field = { stars: [], deep_sky: [], loading: false };
    state.catalogTargets.clear();
    try { localStorage.setItem("night-sky-last", JSON.stringify(data)); } catch (_) { /* 缓存不可写不影响实时结果 */ }
    showCachedSkyNotice(false);
    if (!keepSelection || !state.selected || (!state.selected.id.startsWith("sat:") && !findTarget(state.selected.id))) state.selected = null;
    renderSky();
    renderSelection();
    renderVisibleList();
    if (state.selected) loadEvents();
    requestAnimationFrame(syncSideColumnHeight);
    $("#ephemerisRange").textContent = data.ephemeris.range;
    $("#jsStatus").textContent = "脚本正常";
    renderTimeSlider();
    loadTimelinePreview();
    scheduleFieldLoad();
    if (state.trail.on && reloadTrails) loadTrails();
    updateSatelliteStatus();
    if ($("#satellitePassDetails").open) loadSatellitePasses(48274, $("#satellitePassList"));
    if (loc.sample) showToast("未获取到定位，当前按示例坐标 0°, 0° 计算。");
  } catch (error) {
    if (seq !== state.skySeq || error.name === "AbortError") return;
    if (!state.sky) restoreCachedSky();
    if (state.sky) {
      renderSky(); renderSelection(); renderVisibleList();
      showCachedSkyNotice(true);
      setStatus("显示上次缓存结果", false);
    } else {
      setStatus("星历服务不可用", false);
    }
    showToast(error.message || "无法连接本地天文服务。");
  } finally {
    if (seq === state.skySeq) {
      $("#loadingOverlay").hidden = true;
      state.skyAbort = null;
    }
  }
}

function restoreCachedSky() {
  try {
    const data = JSON.parse(localStorage.getItem("night-sky-last") || "null");
    if (!data || !Array.isArray(data.objects) || !Array.isArray(data.stars)
        || !Number.isFinite(new Date(data.requested_time).getTime())
        || !Number.isFinite(data.location?.latitude) || !Number.isFinite(data.location?.longitude)) return false;
    state.sky = data;
    renderSky(); renderSelection(); renderVisibleList();
    showCachedSkyNotice(true);
    return true;
  } catch (_) { return false; }
}

function showCachedSkyNotice(show) {
  const notice = $("#cachedSkyNotice");
  notice.hidden = !show;
  if (!show || !state.sky) return;
  const location = state.sky.location;
  const date = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(state.sky.requested_time));
  notice.textContent = `显示上次结果：${date}（本地时间） · 纬度 ${location.latitude.toFixed(3)}° / 经度 ${location.longitude.toFixed(3)}°。上方控件为待更新的时间与地点。`;
}

function findTarget(id) {
  if (id.startsWith("sat:")) return satelliteTargets().find((item) => item.id === id) || null;
  if (!state.sky) return null;
  return state.sky.objects.find((item) => item.id === id)
    || state.sky.stars.find((item) => item.id === id)
    || (state.sky.messier || []).find((item) => item.id === id)
    || state.field.stars.find((item) => item.id === id)
    || state.field.deep_sky.find((item) => item.id === id)
    || state.catalogTargets.get(id)
    || null;
}

function scheduleRefresh(options = {}) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refreshSky(options), 280);
}

function setSelected(target) {
  if (!target) return;
  if (target.kind !== "人造天体") state.catalogTargets.set(target.id, target);
  state.selected = target;
  if (state.trail.on) invalidateTrails();
  renderSky();
  renderSelection();
  centerOn(target);
  document.querySelectorAll(".object-row").forEach((row) => row.classList.toggle("active", row.dataset.id === target.id));
  loadEvents();
  if (state.trail.on) loadTrails();
}

function projectPoint(azimuth, altitude, width, height, centerX = width / 2, centerY = height / 2, plotRadius = Math.min(width, height) * 0.405) {
  const alt = Number(altitude);
  const az = Number(azimuth) * Math.PI / 180;
  const r = Math.max(0, (90 - Math.max(0, alt)) / 90) * plotRadius;
  return { x: centerX + Math.sin(az) * r, y: centerY - Math.cos(az) * r, radius: plotRadius };
}

// 视角状态：zoom 为放大倍数，x/y 为画布像素平移量，地图内容本身不变。
const view = { zoom: 1, x: 0, y: 0, pointers: new Map(), pinch: null, moved: 0, downAt: 0, pinched: false, suppressClickUntil: 0, sawPointer: false, dragging: false };
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

function canvasMetrics() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const toolbar = $(".sky-toolbar-only");
  const toolbarRect = toolbar?.getBoundingClientRect();
  const bottomControls = $(".sky-bottom-overlays");
  const controlsRect = bottomControls?.getBoundingClientRect();
  const controlsTop = controlsRect?.height ? controlsRect.top - rect.top - 8 : h;
  const visibleHeight = Math.max(h * .52, Math.min(h, controlsTop));
  const radius = Math.min(w, visibleHeight) * 0.405;
  const baseCenterY = visibleHeight / 2;
  const mobileDefaultView = window.innerWidth <= 700 && !$(".sky-panel").classList.contains("expanded");
  const toolbarBottom = toolbarRect?.height ? toolbarRect.bottom - rect.top : 0;
  const cy = mobileDefaultView ? Math.max(baseCenterY, toolbarBottom + 14 + radius) : baseCenterY;
  return { rect, w, h, cx: w / 2, cy, radius, plotTop: Math.max(0, toolbarBottom), plotBottom: Math.min(h, controlsTop) };
}

function clampZoom(value) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function clampView(m) {
  const limit = m.radius * Math.max(0, view.zoom - 1) * 1.15;
  view.x = Math.max(-limit, Math.min(limit, view.x));
  view.y = Math.max(-limit, Math.min(limit, view.y));
}

// 基础投影坐标 → 屏幕坐标（含缩放与平移）。
function toScreen(point, m) {
  return {
    x: m.cx + (point.x - m.cx) * view.zoom + view.x,
    y: m.cy + (point.y - m.cy) * view.zoom + view.y,
  };
}

function screenOf(azimuth, altitude, m) {
  return toScreen(projectPoint(azimuth, altitude, m.w, m.h, m.cx, m.cy, m.radius), m);
}

function fieldCenter() {
  const m = canvasMetrics();
  const baseX = m.cx - view.x / view.zoom;
  const baseY = m.cy - view.y / view.zoom;
  const dx = baseX - m.cx;
  const dy = baseY - m.cy;
  const radial = Math.min(m.radius, Math.hypot(dx, dy));
  return {
    azimuth: (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360,
    altitude: Math.max(0, 90 - radial / m.radius * 90),
    radius: Math.min(95, Math.max(8, 108 / view.zoom + 3)),
  };
}

function fieldLimits() {
  if (view.zoom < 1.45) return null;
  const dsoMagnitude = Math.max(8.5, deepSkyMagnitudeLimit());
  if (view.zoom < 2.4) return { magnitude: 7.2, dsoMagnitude };
  if (view.zoom < 3.8) return { magnitude: 8.6, dsoMagnitude };
  return { magnitude: 10, dsoMagnitude };
}

function scheduleFieldLoad(delay = 180) {
  clearTimeout(state.fieldTimer);
  state.fieldSeq += 1;
  state.fieldAbort?.abort();
  const limits = fieldLimits();
  if (!limits || !state.sky) {
    if (state.field.stars.length || state.field.deep_sky.length) {
      state.field = { stars: [], deep_sky: [], loading: false };
      requestSkyDraw();
    }
    return;
  }
  state.fieldTimer = setTimeout(() => {
    if (view.pointers.size || view.dragging || state.timeline.scrub) return;
    loadField(limits);
  }, delay);
}

async function loadField(limits = fieldLimits()) {
  if (!limits || !state.sky) return;
  const seq = ++state.fieldSeq;
  state.fieldAbort?.abort();
  const controller = new AbortController();
  state.fieldAbort = controller;
  const loc = coords();
  const center = fieldCenter();
  state.field.loading = true;
  try {
    const response = await fetch(buildUrl("/api/field", {
      lat: loc.lat, lon: loc.lon, datetime: skyTimeIso(),
      center_az: center.azimuth, center_alt: center.altitude, radius: center.radius,
      magnitude: limits.magnitude, dso_magnitude: limits.dsoMagnitude,
    }), { cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "深星目录载入失败。");
    if (seq !== state.fieldSeq) return;
    state.field = { stars: data.stars || [], deep_sky: data.deep_sky || [], loading: false };
    requestSkyDraw();
  } catch (error) {
    if (seq !== state.fieldSeq || error.name === "AbortError") return;
    state.field.loading = false;
    console.warn(error);
  } finally {
    if (seq === state.fieldSeq) state.fieldAbort = null;
  }
}

function updateViewUi() {
  canvas.style.touchAction = view.zoom > 1 ? "none" : "pan-y";
  canvas.style.cursor = view.zoom > 1 ? "grab" : "pointer";
}

function isMessierCluster(item) {
  return ["疏散星团", "球状星团", "星协", "双星", "星群"].includes(item.kind);
}

function isDeepSkyTarget(item) {
  return item?.id?.startsWith("messier:") || item?.id?.startsWith("dso:");
}

function deepSkyMagnitudeLimit() {
  if (view.zoom < 2) return 6;
  if (view.zoom < 3) return 9;
  if (view.zoom < 4) return 10.5;
  if (view.zoom < 5) return 11.5;
  return 12.5;
}

function deepSkyDisplay(item, isSelected) {
  if (isSelected) return { marker: true, label: true };
  if (view.zoom < 1.5) return { marker: false, label: false };
  const knownMagnitude = Number.isFinite(item.magnitude);
  const limit = deepSkyMagnitudeLimit();
  // Unknown magnitudes are not zero-magnitude objects; only large ones surface.
  const marker = knownMagnitude ? item.magnitude <= limit
    : view.zoom >= 4 && Number(item.major_arcmin) >= 8;
  return { marker, label: marker && view.zoom >= 3 && knownMagnitude && item.magnitude <= limit - 1 };
}

function deepSkyLayout(items, m) {
  const selected = state.selected && findTarget(state.selected.id);
  const byId = new Map(items.map((item) => [item.id, item]));
  if (isDeepSkyTarget(selected)) byId.set(selected.id, selected);
  const mobile = window.innerWidth <= 700;
  const plotHeight = Math.max(0, m.plotBottom - m.plotTop);
  const maxMarkers = Math.max(1, Math.min(mobile ? 20 : 60, Math.floor(m.w * plotHeight / (mobile ? 14000 : 11000))));
  const spacing = mobile ? 38 : 32;
  const candidates = [];
  for (const item of byId.values()) {
    if (!item.above_horizon) continue;
    const isSelected = item.id === selected?.id;
    const display = deepSkyDisplay(item, isSelected);
    if (!display.marker) continue;
    const p = screenOf(item.azimuth, item.altitude, m);
    if (p.x < 8 || p.x > m.w - 8 || p.y < m.plotTop + 8 || p.y > m.plotBottom - 8) continue;
    const magnitude = Number.isFinite(item.magnitude) ? item.magnitude : 14;
    const priority = isSelected ? -Infinity : magnitude
      - (item.id.startsWith("messier:") ? .6 : 0)
      - Math.min(.8, Math.log2(1 + Math.max(0, Number(item.major_arcmin) || 0)) * .12);
    candidates.push({ item, p, isSelected, display, priority });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.item.id.localeCompare(b.item.id));
  const brightObjects = [...state.sky.objects, ...cachedStarDrawing(state.sky).brightStars]
    .filter((item) => item.above_horizon).map((item) => screenOf(item.azimuth, item.altitude, m));
  const markers = [];
  for (const candidate of candidates) {
    if (markers.length >= maxMarkers) break;
    const p = candidate.p;
    if (!candidate.isSelected && brightObjects.some((point) => Math.hypot(point.x - p.x, point.y - p.y) < 15)) continue;
    if (markers.some((point) => Math.hypot(point.p.x - p.x, point.p.y - p.y) < spacing)) continue;
    markers.push(candidate);
  }
  return markers;
}

function drawDeepSkyLabels(markers, m, boxes, selectedOnly) {
  const mobile = window.innerWidth <= 700;
  const limit = mobile ? 6 : 12;
  for (const { item, p, isSelected, display } of markers) {
    if (isSelected !== selectedOnly || !display.label) continue;
    if (!isSelected && state.deepSkyLabels.length >= limit) break;
    ctx.font = `${isSelected ? 11 : 9}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const text = item.catalog || item.name;
    const width = ctx.measureText(text).width;
    for (const [dx, dy] of [[7, -9], [7, 10], [-width - 7, -9], [-width - 7, 10]]) {
      const x = p.x + dx, y = p.y + dy;
      const box = { x1: x - 2, y1: y - 6, x2: x + width + 2, y2: y + 6 };
      if (box.x1 < 4 || box.x2 > m.w - 4 || box.y1 < m.plotTop || box.y2 > m.plotBottom || overlaps(boxes, box)) continue;
      ctx.fillStyle = isSelected ? "rgba(205, 220, 247, .98)" : "rgba(157, 183, 228, .48)";
      ctx.fillText(text, x, y);
      boxes.push(box);
      state.deepSkyLabels.push({ id: item.id, ...box });
      break;
    }
  }
}

// 桌面右栏以星图卡片的自然高度为上限，避免详情内容反过来撑高整行。
function syncSideColumnHeight() {
  const skyPanel = $(".sky-panel");
  const sideColumn = $(".side-column");
  if (!skyPanel || !sideColumn) return;
  if (window.innerWidth <= 700 || skyPanel.classList.contains("expanded")) {
    sideColumn.style.height = "";
    return;
  }
  const height = Math.round(skyPanel.getBoundingClientRect().height);
  if (height > 0) sideColumn.style.height = `${height}px`;
}

// 以画布内某点为锚点缩放，锚点处的星点保持不动。
function zoomTo(nextZoom, clientX, clientY) {
  const m = canvasMetrics();
  const target = clampZoom(nextZoom);
  if (Math.abs(target - view.zoom) < 0.001) return;
  const fx = clientX === undefined ? m.w / 2 : clientX - m.rect.left;
  const fy = clientY === undefined ? m.h / 2 : clientY - m.rect.top;
  const k = target / view.zoom;
  view.x = fx - m.cx - (fx - m.cx - view.x) * k;
  view.y = fy - m.cy - (fy - m.cy - view.y) * k;
  view.zoom = target;
  clampView(m);
  updateViewUi();
  requestSkyDraw();
  scheduleFieldLoad();
}

function resetView() {
  view.zoom = 1;
  view.x = 0;
  view.y = 0;
  updateViewUi();
  drawSky();
  scheduleFieldLoad();
}

// 平移视图，让指定天体回到画面中间（仅在已放大时有意义）。
function centerOn(target) {
  if (view.zoom <= 1 || !target || !target.above_horizon) return;
  const m = canvasMetrics();
  const point = screenOf(target.azimuth, target.altitude, m);
  const margin = Math.min(m.w, m.h) * 0.2;
  if (point.x > margin && point.x < m.w - margin && point.y > margin && point.y < m.h - margin) return;
  const base = projectPoint(target.azimuth, target.altitude, m.w, m.h, m.cx, m.cy, m.radius);
  view.x = (m.cx - base.x) * view.zoom;
  view.y = (m.cy - base.y) * view.zoom;
  clampView(m);
  drawSky();
  scheduleFieldLoad();
}

function isNamedStar(star) {
  return star.named ?? !star.name.startsWith("HIP ");
}

// 近地平线的大气会削弱星光；这里采用标准空气质量近似和温和的消光系数。
// 返回的是用于屏幕显示的观测视星等，不修改目录里的原始视星等。
function observedStarMagnitude(star) {
  const magnitude = Number(star.magnitude);
  const altitude = Math.max(.1, Math.min(90, Number(star.altitude)));
  const radians = altitude * Math.PI / 180;
  const airmass = 1 / (Math.sin(radians) + .50572 * ((altitude + 6.07995) ** -1.6364));
  const extinction = Math.min(3.5, Math.max(0, (airmass - 1) * .16));
  return magnitude + extinction;
}

// 视星等是对数标度：每差 1 等，光通量约差 2.512 倍。星点面积按相对光通量
// 缩放并保留暗星下限，既维持真实亮度顺序，也避免亮星或暗星在屏幕上失控。
function starVisual(star) {
  const magnitude = observedStarMagnitude(star);
  const flux = 10 ** (-.4 * magnitude);
  return {
    magnitude,
    flux,
    radius: Math.max(.5, Math.min(4, .52 + 1.45 * Math.sqrt(flux))),
    alpha: Math.max(.3, Math.min(1, .3 + .7 * (1 - Math.exp(-1.35 * flux)))),
  };
}

// 全景也显示最亮的专名恒星；倍率越大，再逐步标注较暗的星。
function starLabelMagnitude() {
  if (view.zoom < 1.5) return 1.65;
  if (view.zoom < 2.5) return 2.8;
  if (view.zoom < 4) return 4;
  return 5.4;
}

function starLabelCount() {
  const mobile = window.innerWidth <= 700;
  if (view.zoom < 1.5) return mobile ? 8 : 16;
  if (view.zoom < 2.5) return mobile ? 16 : 30;
  if (view.zoom < 4) return mobile ? 28 : 48;
  return mobile ? 40 : 70;
}

function cachedStarDrawing(data) {
  const fieldStars = state.timeline.scrub ? null : state.field.stars;
  if (starDrawingCache?.stars === data.stars && starDrawingCache.fieldStars === fieldStars
      && starDrawingCache.time === data.requested_time) return starDrawingCache;
  const entries = [], labelStars = [], brightStars = [];
  const byHip = new Map();
  for (const star of [...(fieldStars || []), ...data.stars]) {
    if (star.hip) byHip.set(star.hip, star);
    if (!star.above_horizon) continue;
    const az = Number(star.azimuth) * Math.PI / 180;
    const radial = Math.max(0, (90 - Number(star.altitude)) / 90);
    const visual = starVisual(star);
    const entry = { star, visual, x: Math.sin(az) * radial, y: -Math.cos(az) * radial };
    entries.push(entry);
    if (star.magnitude <= 2) brightStars.push(star);
    if (isNamedStar(star) && visual.magnitude <= 5.4) {
      entry.priority = visual.magnitude - Math.max(0, Number(star.altitude)) / 180;
      labelStars.push(entry);
    }
  }
  labelStars.sort((a, b) => a.priority - b.priority || b.star.altitude - a.star.altitude);
  starDrawingCache = { stars: data.stars, fieldStars, time: data.requested_time, entries, labelStars, brightStars, byHip };
  return starDrawingCache;
}

function cachedStarScreen(entry, m) {
  return {
    x: m.cx + entry.x * m.radius * view.zoom + view.x,
    y: m.cy + entry.y * m.radius * view.zoom + view.y,
  };
}

function drawStarPoints(entries, m, dotScale, mobilePointScale, focusBackdrop, selectedId, paintCtx = ctx) {
  const batches = new Map(), glowing = [];
  for (const entry of entries) {
    const p = cachedStarScreen(entry, m);
    if (p.x < -20 || p.y < -20 || p.x > m.w + 20 || p.y > m.h + 20) continue;
    const isSelected = entry.star.id === selectedId;
    const visual = entry.visual;
    const alpha = focusBackdrop && !isSelected ? visual.alpha * .14 : visual.alpha;
    const r = visual.radius * dotScale * mobilePointScale * (focusBackdrop && isSelected ? 1.45 : 1);
    if (isSelected || visual.magnitude < 1.5) {
      glowing.push({ p, r, alpha, visual, isSelected });
      continue;
    }
    // Faint stars share a path instead of thousands of independent fills.
    const radius = Math.round(r * 10) / 10;
    const opacity = Math.round(alpha * 40) / 40;
    const key = `${radius}:${opacity}`;
    let batch = batches.get(key);
    if (!batch) { batch = { radius, opacity, points: [] }; batches.set(key, batch); }
    batch.points.push(p);
  }
  paintCtx.shadowBlur = 0;
  for (const { radius, opacity, points } of batches.values()) {
    paintCtx.beginPath();
    for (const p of points) {
      paintCtx.moveTo(p.x + radius, p.y);
      paintCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    }
    paintCtx.fillStyle = `rgba(236, 240, 246, ${opacity})`;
    paintCtx.fill();
  }
  paintCtx.shadowColor = "rgba(184, 204, 235, .42)";
  for (const { p, r, alpha, visual, isSelected } of glowing) {
    paintCtx.beginPath(); paintCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
    paintCtx.fillStyle = `rgba(236, 240, 246, ${alpha})`;
    paintCtx.shadowBlur = isSelected ? 8 : Math.min(window.innerWidth <= 700 ? 3 : 5, 1.5 + visual.flux);
    paintCtx.fill();
  }
  paintCtx.shadowBlur = 0;
}

function drawStarLayer(stars, m, dpr, dotScale, mobilePointScale, focusBackdrop, selectedId) {
  // During time scrubbing every position changes, so a raster cache cannot help.
  if (state.timeline.scrub) {
    drawStarPoints(stars.entries, m, dotScale, mobilePointScale, focusBackdrop, selectedId);
    return;
  }
  const cached = starLayerCache;
  const reusable = cached && cached.stars === stars && cached.zoom === view.zoom
    && cached.w === m.w && cached.h === m.h && cached.cx === m.cx && cached.cy === m.cy
    && cached.radius === m.radius && cached.dpr === dpr
    && cached.focus === focusBackdrop && cached.selectedId === selectedId
    && Math.abs(view.x - cached.x) < cached.margin * .8
    && Math.abs(view.y - cached.y) < cached.margin * .8;
  if (!reusable) {
    const margin = Math.min(160, Math.min(m.w, m.h) * .35);
    const width = m.w + margin * 2, height = m.h + margin * 2;
    const layer = cached?.canvas || document.createElement("canvas");
    layer.width = Math.ceil(width * dpr);
    layer.height = Math.ceil(height * dpr);
    const layerCtx = layer.getContext("2d");
    layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStarPoints(stars.entries, { ...m, w: width, h: height, cx: m.cx + margin, cy: m.cy + margin },
      dotScale, mobilePointScale, focusBackdrop, selectedId, layerCtx);
    starLayerCache = { canvas: layer, stars, x: view.x, y: view.y, zoom: view.zoom, margin,
      w: m.w, h: m.h, cx: m.cx, cy: m.cy, radius: m.radius, dpr, focus: focusBackdrop, selectedId };
  }
  const layer = starLayerCache;
  ctx.drawImage(layer.canvas, 0, 0, layer.canvas.width, layer.canvas.height,
    view.x - layer.x - layer.margin, view.y - layer.y - layer.margin,
    layer.canvas.width / dpr, layer.canvas.height / dpr);
}

function overlaps(placed, box) {
  return placed.some((item) => !(box.x2 < item.x1 || box.x1 > item.x2 || box.y2 < item.y1 || box.y1 > item.y2));
}

// 月盘按日月黄经差绘制：0° 为新月、180° 为满月。
function drawMoonDisc(x, y, radius, phase) {
  const angle = ((Number(phase) % 360) + 360) % 360;
  const radians = angle * Math.PI / 180;
  const limbSide = angle <= 180 ? 1 : -1;

  ctx.save();
  ctx.shadowColor = "rgba(230, 235, 213, .72)";
  ctx.shadowBlur = radius * 1.8;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#26343b"; ctx.fill();
  ctx.shadowBlur = 0;

  ctx.beginPath();
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    const a = -Math.PI / 2 + Math.PI * i / steps;
    const px = x + limbSide * Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  for (let i = steps; i >= 0; i -= 1) {
    const a = -Math.PI / 2 + Math.PI * i / steps;
    ctx.lineTo(x + limbSide * Math.cos(radians) * Math.cos(a) * radius, y + Math.sin(a) * radius);
  }
  ctx.closePath();
  ctx.fillStyle = "#f1efd8"; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 251, 218, .82)"; ctx.lineWidth = .8; ctx.stroke();
  ctx.restore();
}

function drawMilkyWay(points, m, dimmed = false) {
  if (!Array.isArray(points) || points.length < 2) return;
  const center = toScreen({ x: m.cx, y: m.cy }, m);
  const pixelsPerDegree = m.radius * view.zoom / 90;
  const layers = [
    { width: 25 * pixelsPerDegree, color: "rgba(112, 130, 151, .022)" },
    { width: 14 * pixelsPerDegree, color: "rgba(137, 151, 170, .032)" },
    { width: 5 * pixelsPerDegree, color: "rgba(175, 181, 190, .038)" },
  ];
  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, m.radius * view.zoom, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = dimmed ? .24 : 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  layers.forEach((layer) => {
    ctx.beginPath();
    let started = false;
    points.forEach((point) => {
      if (Number(point.altitude) <= 0) { started = false; return; }
      const p = screenOf(point.azimuth, point.altitude, m);
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    });
    ctx.lineWidth = layer.width;
    ctx.strokeStyle = layer.color;
    ctx.stroke();
  });
  ctx.restore();
}

function drawSky() {
  if (skyDrawFrame) { cancelAnimationFrame(skyDrawFrame); skyDrawFrame = 0; }
  const data = state.sky;
  if (!data) return;
  const m = canvasMetrics();
  const w = m.w;
  const h = m.h;
  if (!w || !h) return;
  const selectedId = state.selected?.id || null;
  const trailData = currentTrailData();
  const focusedTrail = Boolean(
    trailData?.target
    && trailData.target.id === selectedId
  );
  const focusBackdrop = Boolean((state.trail.on && selectedId && (focusedTrail || state.trail.loading))
    || (selectedId?.startsWith("sat:") && findTarget(selectedId)));
  const mobilePointScale = window.innerWidth <= 700 ? .72 : 1;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(w * dpr);
  const pixelHeight = Math.round(h * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // 画布背景铺满矩形区域，星图投影保持圆形比例。
  const stage = ctx.createRadialGradient(m.cx, m.cy, 0, m.cx, m.cy, Math.hypot(w, h) * .56);
  stage.addColorStop(0, "#111820");
  stage.addColorStop(1, "#080b0f");
  ctx.fillStyle = stage;
  ctx.fillRect(0, 0, w, h);

  const center = toScreen({ x: m.cx, y: m.cy }, m);
  const glow = ctx.createRadialGradient(center.x, center.y, 5, center.x, center.y, m.radius * view.zoom * 1.2);
  glow.addColorStop(0, "rgba(22, 27, 34, .98)");
  glow.addColorStop(.72, "rgba(15, 19, 24, .98)");
  glow.addColorStop(1, "rgba(10, 13, 17, 1)");
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(center.x, center.y, m.radius * view.zoom * 1.19, 0, Math.PI * 2); ctx.fill();

  // 银河永远位于网格、星点和标签之下，只作为低对比度背景带。
  drawMilkyWay(data.milky_way, m, focusBackdrop);

  ctx.save();
  ctx.strokeStyle = "rgba(148, 163, 184, .14)";
  ctx.lineWidth = 1;
  [30, 60, 90].forEach((altitude) => {
    const r = (90 - altitude) / 90 * m.radius * view.zoom;
    ctx.beginPath(); ctx.arc(center.x, center.y, r, 0, Math.PI * 2); ctx.stroke();
    if (altitude < 90) {
      ctx.fillStyle = "rgba(148, 163, 184, .62)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(`${altitude}°`, center.x + 4, center.y - r - 3);
    }
  });
  ctx.setLineDash([3, 7]);
  for (let az = 0; az < 360; az += 45) {
    const p = screenOf(az, 0, m);
    ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(p.x, p.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(148, 163, 184, .34)";
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(center.x, center.y, m.radius * view.zoom, 0, Math.PI * 2); ctx.stroke();
  [
    ["北", 0], ["东", 90], ["南", 180], ["西", 270],
  ].forEach(([label, az]) => {
    const p = screenOf(Number(az), 0, m);
    ctx.fillStyle = label === "北" ? "rgba(126, 166, 238, .96)" : "rgba(203, 213, 225, .78)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(label), p.x, p.y);
  });
  ctx.restore();

  // 标签避让：先放星座名，再放行星/太阳/月球，最后补恒星名。
  const boxes = [];
  const starDrawing = cachedStarDrawing(data);
  const byHip = starDrawing.byHip;
  ctx.save();
  ctx.globalAlpha = focusBackdrop ? .2 : 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(100, 116, 139, .34)";
  constellationLines.forEach(([name, ids]) => {
    ctx.beginPath();
    let started = false;
    const points = [];
    ids.forEach((id) => {
      const star = byHip.get(id);
      if (!star || star.altitude < 0) { started = false; return; }
      const p = screenOf(star.azimuth, star.altitude, m);
      points.push(p);
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    if (points.length < 3 || view.zoom < 2) return;
    const labelX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const labelY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    ctx.fillStyle = "rgba(148, 163, 184, .55)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(name, labelX, labelY);
    const labelWidth = ctx.measureText(name).width;
    boxes.push({ x1: labelX - labelWidth / 2 - 3, y1: labelY - 9, x2: labelX + labelWidth / 2 + 3, y2: labelY + 7 });
  });
  ctx.restore();

  if (trailData) drawTrailBackgrounds(trailData, m);

  const dotScale = Math.min(1.9, 1 + (view.zoom - 1) * 0.3);
  drawStarLayer(starDrawing, m, dpr, dotScale, mobilePointScale, focusBackdrop, selectedId);

  // 深空目标渐进显示：星团用柔和空心圆，星云和星系用菱形。
  const plottedDeepSky = [...(data.messier || []), ...(state.timeline.scrub ? [] : state.field.deep_sky)];
  const deepSkyMarkers = deepSkyLayout(plottedDeepSky, m);
  state.deepSkyMarkers = deepSkyMarkers;
  state.deepSkyLabels = [];
  deepSkyMarkers.forEach(({ item, p, isSelected }) => {
    const cluster = isMessierCluster(item);
    const size = isSelected ? 5.2 : cluster ? 2.6 : 2.1;
    ctx.save();
    ctx.globalAlpha = focusBackdrop && !isSelected ? .1 : isSelected ? 1 : cluster ? .28 : .34;
    ctx.translate(p.x, p.y);
    ctx.strokeStyle = isSelected ? "#b9d0f7" : "#819bc8";
    ctx.lineWidth = isSelected ? 1.6 : .8;
    if (cluster) {
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.05, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.rotate(Math.PI / 4);
      ctx.strokeRect(-size, -size, size * 2, size * 2);
    }
    ctx.restore();
  });

  // 主轨迹压在背景星点之上，当前位置和标签随后再覆盖它。
  if (focusedTrail) strokeTargetTrail(trailData, m);

  // 行星、太阳、月球的名字始终显示；恒星名按亮度和避让结果补上。
  const labelFont = `${view.zoom >= 3 ? 12 : 11}px system-ui, sans-serif`;
  data.objects.filter((object) => object.above_horizon).forEach((object) => {
    const p = screenOf(object.azimuth, object.altitude, m);
    const isSelected = object.id === selectedId;
    const isMoon = object.id === "moon";
    const isSun = object.id === "sun";
    const color = isSun ? "#f1ede2" : isMoon ? "#e7e7df" : "#9db7e8";
    ctx.save();
    ctx.globalAlpha = focusBackdrop && !isSelected ? .16 : 1;
    if (isMoon) {
      drawMoonDisc(p.x, p.y, 7.2 * dotScale * (window.innerWidth <= 700 ? .82 : 1), object.phase);
    } else {
      ctx.beginPath(); ctx.arc(p.x, p.y, (isSun ? 4.1 : 2.7) * dotScale * mobilePointScale, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 11; ctx.fill(); ctx.shadowBlur = 0;
    }
    ctx.fillStyle = "rgba(226, 232, 240, .92)";
    ctx.font = labelFont;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(object.name, p.x + 8, p.y - 7);
    const labelWidth = ctx.measureText(object.name).width;
    boxes.push({ x1: p.x + 6, y1: p.y - 18, x2: p.x + 12 + labelWidth, y2: p.y + 2 });
    ctx.restore();
  });

  const labelLimit = starLabelMagnitude();
  if (focusedTrail) drawTargetTrail(trailData, m, boxes);
  drawSatellites(m, boxes);
  drawDeepSkyLabels(deepSkyMarkers, m, boxes, true);
  if (labelLimit !== null && !focusBackdrop) {
    const candidates = starDrawing.labelStars
      .filter(({ star, visual }) => star.id !== selectedId && visual.magnitude <= labelLimit)
      .slice(0, starLabelCount());
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(203, 213, 225, .82)";
    for (const entry of candidates) {
      const star = entry.star;
      const p = cachedStarScreen(entry, m);
      if (p.x < 4 || p.y < 10 || p.x > w - 4 || p.y > h - 8) continue;
      const box = { x1: p.x + 5, y1: p.y - 9, x2: p.x + 11 + ctx.measureText(star.name).width, y2: p.y + 6 };
      if (overlaps(boxes, box)) continue;
      boxes.push(box);
      ctx.fillText(star.name, p.x + 7, p.y - 1);
    }
  }

  drawDeepSkyLabels(deepSkyMarkers, m, boxes, false);
  const selected = state.selected && findTarget(state.selected.id);
  if (selected && selected.above_horizon) {
    const p = screenOf(selected.azimuth, selected.altitude, m);
    ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(126, 166, 238, .96)"; ctx.lineWidth = 1.1; ctx.shadowColor = "#7ea6ee"; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
    if (selected.kind === "恒星") {
      ctx.fillStyle = "rgba(191, 213, 250, .95)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(selected.name, p.x + 10, p.y + 13);
    }
  }
}

// 轨迹只画地平线以上的部分：地平线以下的点在地图边缘会挤成一圈。
function strokeTrail(points, m, { width = 1, color = "rgba(148, 163, 184, .22)", dash = null, shadow = null } = {}) {
  ctx.save();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  if (shadow) { ctx.shadowColor = shadow; ctx.shadowBlur = 8; }
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (const [az, alt] of points) {
    if (alt < 0) { started = false; continue; }
    const p = screenOf(az, alt, m);
    if (!started) { ctx.moveTo(p.x, p.y); started = true; }
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawTrailBackgrounds(data, m) {
  const color = data.target ? "rgba(148, 163, 184, .055)" : "rgba(148, 163, 184, .2)";
  const width = data.target ? .7 : 1;
  data.stars.forEach((track) => strokeTrail(track.points, m, { width, color }));
}

function strokeTargetTrail(data, m) {
  if (!data.target) return;
  strokeTrail(data.target.points, m, {
    width: window.innerWidth <= 700 ? 2 : 2.35,
    color: "rgba(126, 166, 238, .96)",
    shadow: "rgba(80, 125, 205, .62)",
  });
}

function drawTargetTrail(data, m, boxes = []) {
  if (!data.target) return;
  const markers = [
    ...((data.events && data.events.rise) || []).map((item) => ({ ...item, text: "升起", color: "#9db7e8" })),
    ...((data.events && data.events.transit) || []).map((item) => ({ ...item, text: "中天", color: "#d5dbe5" })),
    ...((data.events && data.events.set) || []).map((item) => ({ ...item, text: "落下", color: "#78879d" })),
  ];
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  // Rise/set use the refracted upper limb; the center can be below −0.5°.
  markers.filter((item) => item.text !== "中天" || item.altitude >= 0).forEach((item) => {
    const p = screenOf(item.azimuth, Math.max(0, item.altitude), m);
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = item.color; ctx.fill();
    const text = `${item.text} ${displayClock(item.time, true)}`;
    const width = ctx.measureText(text).width;
    const offsets = [[7, 11], [7, 29], [7, -15], [-width - 7, 11], [-width - 7, 29], [-width - 7, -15], [7, 47], [-width - 7, 47]];
    for (const [dx, dy] of offsets) {
      const x = p.x + dx, y = p.y + dy;
      const box = { x1: x - 3, y1: y - 7, x2: x + width + 3, y2: y + 7 };
      if (box.x1 < 4 || box.x2 > m.w - 4 || box.y1 < 4 || box.y2 > m.h - 4 || overlaps(boxes, box)) continue;
      boxes.push(box);
      ctx.fillStyle = "rgba(226, 232, 240, .92)";
      ctx.fillText(text, x, y);
      break;
    }
  });
}

function updateTrailNote() {
  const note = $("#trailNote");
  if (!note) return;
  note.hidden = !state.trail.on;
  if (!state.trail.on) { note.textContent = ""; return; }
  if (state.selected?.kind === "人造天体") { note.textContent = "人造天体轨迹 · 前后 10 分钟"; return; }
  if (state.trail.loading) { note.textContent = "正在计算轨迹…"; return; }
  const data = currentTrailData();
  if (!data) { note.textContent = "轨迹数据不可用"; return; }
  const scope = data.target ? `${data.target.name}轨迹` : "亮星轨迹";
  note.textContent = `${scope} · ${displayClock(data.start, true)} → ${displayClock(data.end, true)}`;
}

function invalidateTrails() {
  state.trail.seq += 1;
  state.trail.abort?.abort();
  state.trail.abort = null;
  state.trail.data = null;
  state.trail.loading = false;
  updateTrailNote();
}

function currentTrailData() {
  const data = state.trail.data;
  if (!state.trail.on || !data || !state.sky) return null;
  if ((data.target?.id || null) !== (state.selected?.id || null)) return null;
  const moment = new Date(state.sky.requested_time).getTime();
  if (moment < new Date(data.start).getTime() || moment > new Date(data.end).getTime()) return null;
  if (state.timeline.mode === "day" && moment !== data.requestedCenter) return null;
  return data;
}

async function loadTrails() {
  if (!state.trail.on) return;
  if (state.selected?.kind === "人造天体") {
    state.trail.seq += 1;
    state.trail.data = null;
    state.trail.loading = false;
    updateTrailNote();
    drawSky();
    return;
  }
  if (!state.sky) {
    showToast("星历还没加载完成，请稍候再点轨迹。");
    return;
  }
  const loc = coords();
  // Hour mode shares its fixed slider center; day mode follows the selected day.
  const spanMinutes = state.trail.halfHours * 120;
  const center = state.timeline.mode === "day" ? selectedDate().getTime() : timelineBounds().center;
  const step = state.trail.halfHours <= 3 ? 5 : state.trail.halfHours <= 6 ? 10 : 15;
  const query = {
    lat: loc.lat,
    lon: loc.lon,
    elevation: loc.elevation || 0,
    start: new Date(center - spanMinutes * 30000).toISOString(),
    span: spanMinutes,
    step,
  };
  if (state.selected && state.selected.kind !== "人造天体") {
    query.target = state.selected.id;
    // 聚焦模式只需要目标轨迹；省去每次重复计算整批亮星轨迹。
    query.stars = false;
  }
  const seq = ++state.trail.seq;
  state.trail.abort?.abort();
  const controller = new AbortController();
  state.trail.abort = controller;
  state.trail.data = null;
  state.trail.loading = true;
  updateTrailNote();
  drawSky();
  try {
    const response = await fetch(buildUrl("/api/trails", query), { cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "轨迹计算失败。");
    if (seq !== state.trail.seq) return;
    data.requestedCenter = center;
    state.trail.data = data;
  } catch (error) {
    if (seq === state.trail.seq && error.name !== "AbortError") {
      state.trail.data = null;
      showToast(error.message || "轨迹计算失败。");
    }
  } finally {
    if (seq === state.trail.seq) {
      state.trail.loading = false;
      state.trail.abort = null;
      updateTrailNote();
      drawSky();
    }
  }
}

function setTrailEnabled(on) {
  state.trail.on = on;
  const button = $("#trailBtn");
  if (button) {
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "隐藏星星轨迹" : "显示星星轨迹");
    button.title = on ? "隐藏星星轨迹" : "显示星星轨迹";
  }
  if (!on) {
    invalidateTrails();
  }
  updateTrailNote();
  drawSky();
  if (on) loadTrails();
}

function setTrailSpan(hours) {
  state.trail.halfHours = hours;
  document.querySelectorAll("#trailSpan .seg-button").forEach((button) => {
    const active = Number(button.dataset.hours) === hours;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (state.timeline.mode === "hour") resetTimeline(selectedDate());
  else renderTimeSlider();
  loadTimelinePreview();
  updateTrailNote();
  if (state.trail.on) loadTrails();
}

function objectCount() {
  if (!state.sky) return 0;
  const solar = state.sky.objects.filter((item) => item.above_horizon).length;
  return solar + (state.sky.visible_star_count ?? 0) + (state.sky.visible_messier_count ?? 0)
    + satelliteTargets().filter((target) => target.visible).length;
}

function renderSky() {
  if (!state.sky) return;
  drawSky();
  $("#sunAltitude").textContent = formatAltitude(state.sky.sun_altitude);
  $("#darknessLabel").textContent = twilightInfo(state.sky.sun_altitude).label;
  $("#visibleCount").textContent = objectCount().toLocaleString("zh-CN");
  const moon = state.sky.moon || state.sky.objects.find((item) => item.id === "moon");
  if (moon) {
    $("#moonStatusGlyph").innerHTML = moonPhaseSvg(moon.phase);
    $("#moonStatusText").textContent = formatAltitude(moon.altitude);
    $("#moonStatusBtn").classList.toggle("is-below", !moon.above_horizon);
    $("#moonStatusBtn").title = moon.above_horizon ? "月球当前位于地平线上方，点击查看详情" : "月球当前位于地平线下，点击查看升起时间";
  }
}

function renderVisibleList() {
  const list = $("#visibleList");
  if (!state.sky) return;
  const visibleSolar = state.sky.objects.filter((item) => item.above_horizon).map((item) => ({
    ...item,
    glyph: item.id === "moon" ? moonPhaseSvg(item.phase) : glyphOf(item),
    sortKey: Number.isFinite(item.magnitude) ? item.magnitude : Number.POSITIVE_INFINITY,
  }));
  const namedStars = state.sky.stars
    .filter((star) => star.above_horizon && star.magnitude <= 5.4 && isNamedStar(star))
    .map((star) => ({ ...star, glyph: "✦", sortKey: star.magnitude }));
  const messier = (state.sky.messier || [])
    .filter((item) => item.above_horizon)
    .map((item) => ({ ...item, glyph: "◇", sortKey: item.magnitude ?? 12 }));
  const satellites = satelliteTargets().filter((item) => item.visible).map((item) => ({ ...item, glyph: "◇", sortKey: -20 }));
  const rows = [...satellites, ...visibleSolar, ...namedStars, ...messier].sort((a, b) => a.sortKey - b.sortKey || nameCollator.compare(a.name, b.name));
  if (!rows.length) {
    list.innerHTML = '<div class="empty-list">当前时间没有目录天体升在地平线上。</div>';
    return;
  }
  list.innerHTML = rows.map((item) => `
    <button class="object-row ${state.selected?.id === item.id ? "active" : ""}" data-id="${escapeAttr(item.id)}" data-kind="${escapeAttr(item.kind)}">
      <span class="row-glyph">${item.glyph}</span>
      <span class="row-name">${escapeHtml(item.name)}<span class="row-sub">${escapeHtml(item.kind)} · ${Number.isFinite(item.magnitude) ? `视星等 ${formatMagnitude(item.magnitude)} · ` : ""}高度 ${formatAltitude(item.altitude)}</span></span>
      <span class="row-direction">${azimuthOf(item.azimuth).toFixed(1)}°<small>${azimuthCompass(item.azimuth)}</small></span>
    </button>`).join("");
  list.querySelectorAll(".object-row").forEach((row) => row.addEventListener("click", () => setSelected(findTarget(row.dataset.id))));
}

function renderSelection() {
  const target = state.selected && findTarget(state.selected.id);
  $("#emptySelection").hidden = Boolean(target);
  $("#selectedDetails").hidden = !target;
  if (!target) return;
  $("#selectedKind").textContent = target.kind;
  $("#selectedName").textContent = target.name;
  const magnitudeText = Number.isFinite(target.magnitude) ? `视星等 ${formatMagnitude(target.magnitude)}` : null;
  $("#selectedSubline").textContent = target.catalog
    ? [target.kind, magnitudeText, target.alias, target.constellation].filter(Boolean).join(" · ")
    : target.kind === "恒星"
    ? [`HIP ${target.hip}`, magnitudeText, target.alias].filter(Boolean).join(" · ")
    : target.id === "moon"
      ? [magnitudeText, `照明 ${Number(target.illumination).toFixed(1)}%`, `月相 ${moonPhaseName(target.phase)}`].filter(Boolean).join(" · ")
      : [magnitudeText, "太阳系天体"].filter(Boolean).join(" · ");
  $("#selectedAz").textContent = `${azimuthOf(target.azimuth).toFixed(1)}°`;
  $("#selectedCompass").textContent = azimuthCompass(target.azimuth);
  $("#selectedAlt").textContent = formatAltitude(target.altitude);
  $("#selectedAltitudeHint").textContent = target.above_horizon ? target.altitude < 10 ? "贴近地平线" : "位于地平线上方" : "当前在地平线下";
  if (target.kind === "人造天体") {
    $("#selectedSubline").textContent = `NORAD ${target.norad} · 距离 ${target.distance_km.toLocaleString("zh-CN")} 千米`;
    $("#selectedAltitudeHint").textContent = satelliteVisibilityText(target);
  }
  if (target.id === "moon") $("#selectedGlyph").innerHTML = moonPhaseSvg(target.phase);
  else $("#selectedGlyph").textContent = glyphOf(target);
}

function moonPhaseName(degrees) {
  const phase = azimuthOf(degrees);
  for (const [angle, name] of [[0, "新月"], [90, "上弦月"], [180, "满月"], [270, "下弦月"]]) {
    if (Math.abs((phase - angle + 540) % 360 - 180) <= 2) return name;
  }
  if (phase < 90) return "蛾眉月";
  if (phase < 180) return "盈凸月";
  if (phase < 270) return "亏凸月";
  return "残月";
}

function allTargets() {
  if (!state.sky) return [];
  const combined = [
    ...satelliteTargets(),
    ...state.sky.objects, ...state.sky.stars, ...(state.sky.messier || []),
    ...(state.timeline.scrub ? [] : [...state.field.stars, ...state.field.deep_sky, ...state.catalogTargets.values()]),
  ];
  return [...new Map(combined.map((target) => [target.id, target])).values()];
}

function normalized(value) {
  return String(value || "").toLocaleLowerCase().replace(/[\s·（）()_-]/g, "");
}

function searchTargets(query) {
  const q = normalized(query);
  if (!q) return [];
  const digits = q.replace(/^hip/, "");
  const hipQuery = /^[0-9]+$/.test(digits) ? digits : "";
  return allTargets().filter((target) => normalized(target.name).includes(q)
    || (target.catalog && normalized(target.catalog).includes(q))
    || (target.alias && normalized(target.alias).includes(q))
    || (hipQuery && target.hip && String(target.hip).includes(hipQuery)))
    .sort((a, b) => Number(b.above_horizon) - Number(a.above_horizon) || (a.magnitude ?? -10) - (b.magnitude ?? -10))
    .slice(0, 8);
}

function paintSearchResults(query, targets, loading = false) {
  const box = $("#searchResults");
  if (!query.trim()) { box.hidden = true; return; }
  box.hidden = false;
  if (!targets.length) {
    box.innerHTML = `<div class="empty-list">${loading ? "正在搜索本地目录…" : "没有匹配项。可尝试中文名、IAU 名、拜耳名或 HIP / HD / HR / TYC / NGC / IC 编号。"}</div>`;
    return;
  }
  box.innerHTML = targets.map((target) => `<button class="search-result" data-id="${escapeAttr(target.id)}"><span>${escapeHtml(target.name)}</span><small>${target.above_horizon ? "地平线上方" : "地平线下"} · ${escapeHtml(target.kind)}${target.catalog ? ` · ${escapeHtml(target.catalog)}` : ""}</small></button>`).join("");
  box.querySelectorAll(".search-result").forEach((button) => button.addEventListener("click", () => {
    setSelected(findTarget(button.dataset.id));
    box.hidden = true;
    $("#searchInput").blur();
  }));
}

async function renderSearchResults(query) {
  const trimmed = query.trim();
  const seq = ++state.searchSeq;
  if (!trimmed) { paintSearchResults(query, []); state.searchResults = []; return []; }
  const local = searchTargets(query);
  state.searchResults = local;
  paintSearchResults(query, local, true);
  if (trimmed.length < 2 && !/\d/.test(trimmed)) return local;
  const loc = coords();
  try {
    const response = await fetch(buildUrl("/api/search", {
      q: trimmed, lat: loc.lat, lon: loc.lon, datetime: skyTimeIso(),
    }), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "目录搜索失败。");
    if (seq !== state.searchSeq) return [];
    const merged = [...new Map([...local, ...(data.results || [])].map((target) => [target.id, target])).values()].slice(0, 12);
    for (const target of merged) state.catalogTargets.set(target.id, target);
    state.searchResults = merged;
    paintSearchResults(query, merged, false);
    return merged;
  } catch (error) {
    if (seq !== state.searchSeq) return [];
    state.searchResults = local;
    paintSearchResults(query, local, false);
    console.warn(error);
    return local;
  }
}

function scheduleSearch(query) {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => renderSearchResults(query), 180);
}

async function selectFirstSearchResult(query) {
  clearTimeout(state.searchTimer);
  const results = await renderSearchResults(query);
  if (results[0]) {
    setSelected(results[0]);
    $("#searchResults").hidden = true;
  }
}

async function loadEvents() {
  const target = state.selected && findTarget(state.selected.id);
  if (!target) return;
  const requestId = ++state.eventsSeq;
  if (target.kind === "人造天体") {
    const resultBox = $("#eventsResult");
    resultBox.hidden = false;
    await loadSatellitePasses(target.norad, resultBox, () => requestId === state.eventsSeq && state.selected?.id === target.id);
    return;
  }
  const targetId = target.id;
  const base = selectedDate();
  const localStart = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const localEnd = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  const loc = coords();
  const query = {
    target: target.id,
    lat: loc.lat,
    lon: loc.lon,
    elevation: loc.elevation || 0,
    start: localStart.toISOString(),
    end: localEnd.toISOString(),
  };
  const resultBox = $("#eventsResult");
  resultBox.hidden = false;
  resultBox.innerHTML = '<div class="events-loading"><span class="spinner"></span><span>正在计算升落时刻…</span></div>';
  try {
    const response = await fetch(buildUrl("/api/events", query));
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "事件查询失败。");
    if (requestId !== state.eventsSeq || state.selected?.id !== targetId) return;
    const rows = [];
    const appendEvents = (items, label) => items.forEach((item) => rows.push({ label, item }));
    appendEvents(result.rise, "升起");
    appendEvents(result.transit, "过中天");
    appendEvents(result.set, "落下");
    if (!rows.length) {
      resultBox.innerHTML = '<div class="empty-list">这一天没有升起、过中天或落下事件；目标可能全天在地平线上方或下方。</div>';
    } else {
      resultBox.innerHTML = `<div class="events-grid">${rows.map(({ label, item }) => `<div class="event-row" title="${escapeAttr(displayClock(item.time, true))}"><span>${label}</span><strong>${displayClock(item.time)}</strong><small>${formatAzimuth(item.azimuth)}</small></div>`).join("")}</div>`;
    }
    resultBox.hidden = false;
  } catch (error) {
    if (requestId !== state.eventsSeq || state.selected?.id !== targetId) return;
    showToast(error.message || "事件查询失败。");
    resultBox.innerHTML = '<div class="empty-list">升落时刻暂时无法载入。</div>';
  }
}

function selectAt(clientX, clientY) {
  if (!state.sky) return null;
  const m = canvasMetrics();
  const x = clientX - m.rect.left;
  const y = clientY - m.rect.top;
  // 手指点选比鼠标粗，触屏设备放宽命中范围。
  const radius = window.matchMedia && window.matchMedia("(pointer: coarse)").matches ? 34 : 26;
  let nearest = null;
  let best = radius;
  for (const target of allTargets()) {
    if (!target.above_horizon) continue;
    if (isDeepSkyTarget(target) && !state.deepSkyMarkers.some((marker) => marker.item.id === target.id)) continue;
    if (target.kind === "人造天体" && !satelliteMarkerShown(target)) continue;
    const point = screenOf(target.azimuth, target.altitude, m);
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance >= radius) continue;
    // 轻微偏向亮星：离得近的暗星仍会被选中，但明显更亮的目标优先。
    const bonus = target.kind === "恒星" ? Math.max(0, 4.5 - target.magnitude) * 1.2 : 5;
    const score = distance - bonus;
    if (score < best) { best = score; nearest = target; }
  }
  return nearest;
}

// 点选统一走 click：手机内置浏览器、老版本内核都能触发，比只依赖 pointer 事件可靠。
function handleCanvasTap(clientX, clientY) {
  if (performance.now() < view.suppressClickUntil) return;
  const target = selectAt(clientX, clientY);
  if (!target) {
    showToast("这里没有可点选的天体，放大星图或从列表里选一个。");
    return;
  }
  setSelected(target);
  if (window.innerWidth <= 700) {
    const panel = $(".selected-panel");
    if (panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// 全屏时画布继续铺满整张卡片；工具条和状态区作为覆盖层，不占用画布高度。
function fitExpandedCanvas() {
  const panel = $(".sky-panel");
  const wrap = $(".canvas-wrap");
  if (!panel || !wrap) return;
  if (!panel.classList.contains("expanded")) {
    wrap.style.width = "";
    wrap.style.height = "";
    return;
  }
  wrap.style.width = "100%";
  wrap.style.height = "100%";
}

function toggleExpanded(force) {
  const panel = $(".sky-panel");
  const next = force === undefined ? !panel.classList.contains("expanded") : force;
  panel.classList.toggle("expanded", next);
  document.body.classList.toggle("sky-expanded", next);
  const button = $("#expandBtn");
  if (button) {
    button.setAttribute("aria-pressed", String(next));
    button.setAttribute("aria-label", next ? "退出全屏" : "全屏查看");
    button.setAttribute("title", next ? "退出全屏" : "全屏查看");
  }
  setTimeout(() => { fitExpandedCanvas(); clampView(canvasMetrics()); drawSky(); scheduleFieldLoad(); }, 60);
}

function panBy(dx, dy) {
  if (view.zoom <= 1) return;
  const m = canvasMetrics();
  view.x += dx;
  view.y += dy;
  clampView(m);
  canvas.style.cursor = "grabbing";
  requestSkyDraw();
  scheduleFieldLoad();
}

// 两指捏合：按距离比例缩放，同时跟随两指中点平移。
function applyPinch(distance, midClientX, midClientY) {
  const previous = view.pinch;
  if (!previous) return;
  const m = canvasMetrics();
  const midX = midClientX - m.rect.left;
  const midY = midClientY - m.rect.top;
  const factor = previous.distance > 0 ? distance / previous.distance : 1;
  const target = clampZoom(view.zoom * factor);
  if (target !== view.zoom) {
    const k = target / view.zoom;
    view.x = midX - m.cx - (midX - m.cx - view.x) * k;
    view.y = midY - m.cy - (midY - m.cy - view.y) * k;
    view.zoom = target;
  }
  view.x += midClientX - previous.midX;
  view.y += midClientY - previous.midY;
  view.pinch = { distance, midX: midClientX, midY: midClientY };
  clampView(m);
  updateViewUi();
  requestSkyDraw();
  scheduleFieldLoad();
}

function bindCanvasView() {
  // 点选只用 click：鼠标、触屏和大多数内置浏览器都会触发，最稳。
  canvas.addEventListener("click", (event) => handleCanvasTap(event.clientX, event.clientY));

  canvas.addEventListener("pointerdown", (event) => {
    view.sawPointer = true;
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* 指针已失效时忽略 */ }
    view.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    view.moved = 0;
    view.downAt = performance.now();
    if (view.pointers.size === 2) {
      view.pinched = true;
      const [a, b] = [...view.pointers.values()];
      view.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const prev = view.pointers.get(event.pointerId);
    if (!prev) return;
    view.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (view.pointers.size >= 2 && view.pinch) {
      const [a, b] = [...view.pointers.values()];
      applyPinch(Math.hypot(a.x - b.x, a.y - b.y), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    view.moved += Math.hypot(dx, dy);
    panBy(dx, dy);
  });

  const endPointer = (event) => {
    view.pointers.delete(event.pointerId);
    if (view.pointers.size < 2) view.pinch = null;
    if (!view.pointers.size) {
      if (view.moved >= 8 || view.pinched) view.suppressClickUntil = performance.now() + 400;
      view.pinched = false;
      updateViewUi();
      requestSkyDraw();
      scheduleFieldLoad(0);
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // 触摸回退：仅在该浏览器不派发 pointer 事件时生效（部分手机内置浏览器）。
  let touchLastX = 0, touchLastY = 0, touchMoved = 0, touchPinched = false;
  canvas.addEventListener("touchstart", (event) => {
    if (view.sawPointer) return;
    view.dragging = true;
    const touches = [...event.touches];
    if (touches.length >= 2) {
      const [a, b] = touches;
      touchPinched = true;
      view.pinch = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), midX: (a.clientX + b.clientX) / 2, midY: (a.clientY + b.clientY) / 2 };
    } else if (touches.length === 1) {
      touchLastX = touches[0].clientX;
      touchLastY = touches[0].clientY;
      touchMoved = 0;
      touchPinched = false;
    }
  }, { passive: true });

  canvas.addEventListener("touchmove", (event) => {
    if (view.sawPointer) return;
    const touches = [...event.touches];
    if (touches.length >= 2) {
      const [a, b] = touches;
      if (!view.pinch) {
        view.pinch = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), midX: (a.clientX + b.clientX) / 2, midY: (a.clientY + b.clientY) / 2 };
      }
      touchPinched = true;
      if (event.cancelable) event.preventDefault();
      applyPinch(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      return;
    }
    const touch = touches[0];
    if (!touch) return;
    const dx = touch.clientX - touchLastX;
    const dy = touch.clientY - touchLastY;
    touchLastX = touch.clientX;
    touchLastY = touch.clientY;
    touchMoved += Math.hypot(dx, dy);
    if (view.zoom > 1) {
      if (event.cancelable) event.preventDefault();
      panBy(dx, dy);
    }
  }, { passive: false });

  const endTouch = (event) => {
    if (view.sawPointer) return;
    if (event.touches.length) {
      view.pinch = null;
      touchLastX = event.touches[0].clientX;
      touchLastY = event.touches[0].clientY;
      return;
    }
    if (touchMoved >= 8 || touchPinched) view.suppressClickUntil = performance.now() + 400;
    view.pinch = null;
    touchMoved = 0;
    touchPinched = false;
    view.dragging = false;
    requestSkyDraw();
    scheduleFieldLoad(0);
  };
  canvas.addEventListener("touchend", endTouch);
  canvas.addEventListener("touchcancel", endTouch);

  // 鼠标回退：同样只在没有 pointer 事件时生效（老版本桌面浏览器）。
  let mouseLastX = 0, mouseLastY = 0, mouseMoved = 0, mouseDown = false;
  canvas.addEventListener("mousedown", (event) => {
    if (view.sawPointer) return;
    mouseDown = true;
    view.dragging = true;
    mouseMoved = 0;
    mouseLastX = event.clientX;
    mouseLastY = event.clientY;
  });
  window.addEventListener("mousemove", (event) => {
    if (!mouseDown || view.sawPointer) return;
    const dx = event.clientX - mouseLastX;
    const dy = event.clientY - mouseLastY;
    mouseLastX = event.clientX;
    mouseLastY = event.clientY;
    mouseMoved += Math.hypot(dx, dy);
    panBy(dx, dy);
  });
  window.addEventListener("mouseup", () => {
    if (!mouseDown) return;
    if (mouseMoved >= 8) view.suppressClickUntil = performance.now() + 400;
    mouseDown = false;
    view.dragging = false;
    requestSkyDraw();
    scheduleFieldLoad(0);
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomTo(view.zoom * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
  }, { passive: false });

  canvas.addEventListener("dblclick", (event) => {
    event.preventDefault();
    if (view.zoom > 1.05) resetView();
    else zoomTo(2.6, event.clientX, event.clientY);
  });

  canvas.addEventListener("keydown", (event) => {
    const step = 40;
    const m = canvasMetrics();
    if (event.key === "+" || event.key === "=") { zoomTo(view.zoom * 1.4); event.preventDefault(); }
    else if (event.key === "-" || event.key === "_") { zoomTo(view.zoom / 1.4); event.preventDefault(); }
    else if (event.key === "0") { resetView(); event.preventDefault(); }
    else if (event.key === "Escape") { toggleExpanded(false); }
    else if (event.key.startsWith("Arrow") && view.zoom > 1) {
      view.x += event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
      view.y += event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
      clampView(m);
      requestSkyDraw();
      scheduleFieldLoad();
      event.preventDefault();
    }
  });

  on("#trailBtn", "click", () => setTrailEnabled(!state.trail.on));
  on("#timelineMode", "click", (event) => {
    const button = event.target.closest ? event.target.closest("button[data-mode]") : null;
    if (button) setTimelineMode(button.dataset.mode);
  });
  on("#trailSpan", "click", (event) => {
    const button = event.target.closest ? event.target.closest("button[data-hours]") : null;
    if (button) setTrailSpan(Number(button.dataset.hours) || 6);
  });
  on("#expandBtn", "click", () => toggleExpanded());
}

function satelliteTargets() {
  const data = state.satellites.data;
  const loc = coords();
  if (!data || state.timeline.scrub || !state.sky
      || new Date(data.at).getTime() !== selectedDate().getTime()
      || new Date(state.sky.requested_time).getTime() !== new Date(data.at).getTime()
      || Math.abs(data.location.lat - loc.lat) > 1e-7 || Math.abs(data.location.lon - loc.lon) > 1e-7
      || Math.abs(state.sky.location.latitude - loc.lat) > 1e-7
      || Math.abs(state.sky.location.longitude - loc.lon) > 1e-7) return [];
  return data.objects.filter((item) => state.satellites.enabled.has(item.norad));
}

function satelliteVisibilityText(target) {
  if (!target.above_horizon) return "地平线下";
  if (!target.sunlit) return "地球阴影中";
  if (target.sun_altitude >= -6) return "天空较亮 · 预测位置";
  return "具备观测条件";
}

function satelliteMarkerShown(target) {
  return target.above_horizon && (target.norad === 48274 || target.visible || state.selected?.id === target.id);
}

function invalidateSatellites() {
  const satellite = state.satellites;
  satellite.seq += 1;
  satellite.abort?.abort();
  satellite.abort = null;
  clearTimeout(satellite.retry);
  satellite.data = null;
  satellite.error = "";
  if (state.selected?.kind === "人造天体") {
    state.eventsSeq += 1;
    $("#eventsResult").hidden = true;
    renderSelection();
  }
  updateSatelliteStatus();
}

function updateSatelliteStatus() {
  const data = state.satellites.data;
  $("#satelliteMenuBtn").classList.toggle("has-satellites", state.satellites.enabled.size > 0);
  const messages = [];
  if (data?.objects.length) {
    const epoch = data.objects.find((item) => item.norad === 48274)?.epoch || data.objects[0].epoch;
    messages.push(`轨道历元 ${displayClock(epoch, true)} · CelesTrak`);
    if (data.objects.some((item) => item.approximate)) messages.push("轨道距所选时间超过 2 天，位置仅供参考");
  }
  if (data?.unavailable.length) messages.push(...data.unavailable.map((item) => `${item.name}：${item.reason}`));
  if (state.satellites.error) messages.push(state.satellites.error);
  $("#satelliteDataNote").textContent = messages.join("；");
}

async function loadSatellites(retries = 0) {
  const satellite = state.satellites;
  if (!state.location || !satellite.enabled.size) { updateSatelliteStatus(); return; }
  const seq = ++satellite.seq;
  satellite.abort?.abort();
  const controller = new AbortController();
  satellite.abort = controller;
  const loc = coords();
  try {
    const response = await fetch(buildUrl("/api/artificial-satellites", {
      ids: [...satellite.enabled].join(","), lat: loc.lat, lon: loc.lon,
      elevation: loc.elevation || 0, datetime: skyTimeIso(),
    }), { cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "轨道服务暂时不可用");
    if (seq !== satellite.seq) return;
    satellite.data = data;
    satellite.error = "";
    // 初次后台下载期间只重试几次，历史日期缺少轨道时不重复请求。
    if (data.unavailable.some((item) => !item.epoch) && retries < 4) {
      satellite.retry = setTimeout(() => loadSatellites(retries + 1), 30000);
    }
    renderSky(); renderSelection(); renderVisibleList();
    if (state.selected?.kind === "人造天体") loadEvents();
  } catch (error) {
    if (seq !== satellite.seq || error.name === "AbortError") return;
    satellite.error = error.message || "轨道服务暂时不可用";
    satellite.data = null;
    drawSky(); renderSelection(); renderVisibleList();
  } finally {
    if (seq === satellite.seq) { satellite.abort = null; updateSatelliteStatus(); }
  }
}

function drawSatellites(m, boxes) {
  const selectedId = state.selected?.id;
  for (const target of satelliteTargets()) {
    const selected = target.id === selectedId;
    const color = target.norad === 48274 ? "#edc789" : "#9fbde9";
    const points = target.points;
    ctx.save();
    // 只绘制地平线上方；选择其他目标时淡化卫星图层。
    const backdrop = selectedId && !selected ? .4 : 1;
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1], b = points[index];
      if (!a || !b || a[1] <= 0 || b[1] <= 0) continue;
      if (target.norad !== 48274 && !selected && (!a[3] || !b[3])) continue;
      const p = screenOf(a[0], a[1], m), q = screenOf(b[0], b[1], m);
      if (Math.hypot(q.x - p.x, q.y - p.y) > m.radius * view.zoom * .6) continue;
      const lit = a[2] && b[2];
      ctx.globalAlpha = backdrop * (selected ? .8 : .48) * (lit ? 1 : .35)
        * (.18 + .82 * (1 - Math.abs(index - 60) / 60));
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.setLineDash(lit && index >= 60 ? [] : [3, 4]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // 方向箭头靠近当前点；地平线下则放在未来轨迹中段。
    const arrowIndex = target.above_horizon ? 62 : points.findIndex((point, index) => index > 60 && point?.[1] > 10);
    const before = points[arrowIndex - 1], after = points[arrowIndex];
    if (arrowIndex > 0 && before?.[1] > 0 && after?.[1] > 0
        && (target.norad === 48274 || selected || after[3])) {
      const p = screenOf(before[0], before[1], m), q = screenOf(after[0], after[1], m);
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(Math.atan2(q.y - p.y, q.x - p.x));
      ctx.globalAlpha = backdrop * .55; ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-5, -3); ctx.lineTo(0, 0); ctx.lineTo(-5, 3); ctx.stroke(); ctx.restore();
    }
    if (satelliteMarkerShown(target)) {
      const p = screenOf(target.azimuth, target.altitude, m);
      ctx.globalAlpha = backdrop * (target.visible ? 1 : .5);
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x + 4, p.y);
      ctx.lineTo(p.x, p.y + 4); ctx.lineTo(p.x - 4, p.y); ctx.closePath();
      if (target.visible) ctx.fill(); else ctx.stroke();
      ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const label = `${target.name}${target.visible ? "" : " · 预测"}`;
      const box = { x1: p.x + 7, y1: p.y - 17, x2: p.x + 12 + ctx.measureText(label).width, y2: p.y - 1 };
      if (selected || !overlaps(boxes, box)) { ctx.fillText(label, p.x + 9, p.y - 9); boxes.push(box); }
    }
    ctx.restore();
  }
}

function paintSatelliteChoices() {
  const query = normalized($("#satelliteSearch").value);
  const catalog = state.satellites.catalog.length ? state.satellites.catalog : [
    { norad: 48274, name: "中国空间站" }, { norad: 25544, name: "国际空间站 ISS" }, { norad: 20580, name: "哈勃空间望远镜" },
  ];
  $("#satelliteChoices").innerHTML = catalog
    .filter((item) => !query || normalized(item.name).includes(query) || String(item.norad).includes(query))
    .map((item) => `<label class="satellite-choice"><input type="checkbox" data-norad="${item.norad}" ${state.satellites.enabled.has(item.norad) ? "checked" : ""}/><span>${escapeHtml(item.name)}</span><small>${item.norad}</small></label>`).join("")
    || '<p class="satellite-menu-note">没有匹配的人造天体。</p>';
}

async function openSatelliteMenu(open = true) {
  $("#satellitePopover").hidden = !open;
  $("#satelliteMenuBtn").setAttribute("aria-expanded", String(open));
  if (!open) return;
  paintSatelliteChoices();
  try {
    const response = await fetch("/api/artificial-satellites/catalog", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "轨道目录暂时不可用");
    state.satellites.catalog = data.objects;
    paintSatelliteChoices();
  } catch (error) { $("#satelliteDataNote").textContent = error.message; }
}

function satellitePassRows(data) {
  if (data.unavailable) return `<p class="satellite-menu-note">${escapeHtml(data.unavailable)}</p>`;
  if (!data.passes.length) return '<p class="satellite-menu-note">所选时间后 48 小时内没有符合条件的过境（太阳低于 −6°、天体受光且仰角至少 10°）。</p>';
  const clock = (iso, withDate = false) => new Intl.DateTimeFormat("zh-CN", {
    ...(withDate ? { month: "numeric", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(iso));
  const hours = Math.round((new Date(data.end) - new Date(data.start)) / 3600000);
  return `<p class="satellite-menu-note">所选时间后 ${hours} 小时 · 点击某次过境查看轨迹${data.target.approximate ? " · 轨道较旧，仅供参考" : ""}</p><div class="satellite-event-list">${data.passes.map((pass) => `
    <button type="button" class="satellite-pass-row" data-pass-time="${escapeAttr(pass.peak.time)}" data-norad="${data.target.norad}">
      <span>${clock(pass.start.time, true)} → ${clock(pass.end.time)} · 最高 ${pass.peak.altitude.toFixed(0)}°</span>
      <small>${azimuthCompass(pass.start.azimuth)} → ${azimuthCompass(pass.end.azimuth)} · 最高点 ${clock(pass.peak.time)} · 可观测时段</small>
    </button>`).join("")}</div>`;
}

async function loadSatellitePasses(number, box, stillValid = () => true) {
  const request = String(++state.satellites.passesSeq);
  box.dataset.passRequest = request;
  if (!state.location) { box.innerHTML = '<p class="satellite-menu-note">请先设置观测地点。</p>'; return; }
  box.innerHTML = '<p class="satellite-menu-note">正在计算近期过境…</p>';
  const loc = coords();
  const at = skyTimeIso();
  try {
    const response = await fetch(buildUrl("/api/artificial-satellites/passes", {
      norad: number, lat: loc.lat, lon: loc.lon, elevation: loc.elevation || 0, datetime: at,
    }), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "过境计算暂时不可用");
    if (box.dataset.passRequest !== request || !stillValid() || at !== skyTimeIso()
        || coords().lat !== loc.lat || coords().lon !== loc.lon) return;
    box.innerHTML = satellitePassRows(data);
  } catch (error) {
    if (box.dataset.passRequest === request && stillValid()) box.innerHTML = `<p class="satellite-menu-note">${escapeHtml(error.message)}</p>`;
  }
}

function bindSatelliteEvents() {
  on("#satelliteMenuBtn", "click", () => openSatelliteMenu($("#satellitePopover").hidden));
  on("#satelliteCloseBtn", "click", () => openSatelliteMenu(false));
  on("#satelliteSearch", "input", paintSatelliteChoices);
  on("#satellitePassDetails", "toggle", () => {
    if ($("#satellitePassDetails").open) loadSatellitePasses(48274, $("#satellitePassList"));
  });
  on("#satelliteChoices", "change", (event) => {
    const input = event.target.closest("input[data-norad]");
    if (!input) return;
    const number = Number(input.dataset.norad);
    if (input.checked && state.satellites.enabled.size >= 8) {
      input.checked = false; showToast("最多同时显示 8 个，请先关闭一个天体。"); return;
    }
    if (input.checked) state.satellites.enabled.add(number); else state.satellites.enabled.delete(number);
    try { localStorage.setItem("night-sky-satellites", JSON.stringify([...state.satellites.enabled])); } catch (_) { /* optional preference */ }
    if (!input.checked && state.selected?.id === `sat:${number}`) { state.selected = null; state.eventsSeq += 1; }
    invalidateSatellites(); loadSatellites(); renderSky(); renderSelection(); renderVisibleList();
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.("button[data-pass-time]");
    if (button) {
      const number = Number(button.dataset.norad);
      if (!state.satellites.enabled.has(number) && state.satellites.enabled.size >= 8) { showToast("请先关闭一个天体，再查看此次过境。"); return; }
      state.satellites.enabled.add(number);
      try { localStorage.setItem("night-sky-satellites", JSON.stringify([...state.satellites.enabled])); } catch (_) { /* optional preference */ }
      $("#timeInput").value = localInputValue(new Date(Math.ceil(new Date(button.dataset.passTime).getTime() / 1000) * 1000));
      resetTimeline(selectedDate());
      state.selected = { id: `sat:${number}`, kind: "人造天体" };
      openSatelliteMenu(false);
      await refreshSky();
      const target = findTarget(`sat:${number}`);
      if (target) setSelected(target);
      return;
    }
    if (!event.target.closest?.("#satellitePopover, #satelliteMenuBtn")) openSatelliteMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#satellitePopover").hidden) { openSatelliteMenu(false); $("#satelliteMenuBtn").focus(); }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function escapeAttr(value) { return escapeHtml(value); }

function applyManualLocation() {
  const lat = Number($("#latInput").value);
  const lon = Number($("#lonInput").value);
  const elevation = Number($("#elevationInput").value) || 0;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    showToast("请输入有效纬度（−90 至 90）和经度（−180 至 180）。");
    return;
  }
  setLocation(lat, lon, elevation);
  setManualOpen(false);
  refreshSky();
  showToast("观测地点已更新。");
}

function setNow() {
  $("#timeInput").value = localInputValue(new Date());
  resetTimeline(selectedDate());
  refreshSky();
}

function initInstallPrompt() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function bindEvents() {
  bindSatelliteEvents();
  on("#timeInput", "change", () => {
    const date = parseLocalInput($("#timeInput").value);
    if (!date) {
      $("#timeInput").value = localInputValue(selectedDate());
      showToast("请选择有效的观测时间。");
      return;
    }
    $("#timeInput").value = localInputValue(date);
    resetTimeline(date);
    scheduleRefresh();
  });
  on("#timeSlider", "input", (event) => queueTimelineInput(event.target.value));
  on("#timeSlider", "change", (event) => {
    cancelAnimationFrame(state.timeline.inputFrame);
    state.timeline.inputFrame = 0;
    state.timeline.pendingValue = null;
    setTimeFromSlider(event.target.value);
    finishTimelineScrub();
  });
  on("#nowBtn", "click", setNow);
  on("#locateBtn", "click", async () => {
    if (await locateUser()) {
      setManualOpen(false);
      refreshSky();
    }
  });
  on("#manualToggleBtn", "click", () => setManualOpen($("#manualBlock").hidden));
  on("#applyLocationBtn", "click", applyManualLocation);
  on("#moonStatusBtn", "click", () => {
    const moon = state.sky && (state.sky.moon || findTarget("moon"));
    if (!moon) return;
    setSelected(moon);
    const panel = $(".selected-panel");
    if (window.innerWidth <= 700 && panel?.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  on("#searchInput", "input", (event) => scheduleSearch(event.target.value));
  on("#searchInput", "keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await selectFirstSearchResult(event.target.value);
    }
    if (event.key === "Escape") $("#searchResults").hidden = true;
  });
  on("#searchBtn", "click", () => selectFirstSearchResult($("#searchInput").value));
  bindCanvasView();
  if ("ResizeObserver" in window) {
    const skySizeObserver = new ResizeObserver(() => syncSideColumnHeight());
    skySizeObserver.observe($(".sky-panel"));
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $(".sky-panel").classList.contains("expanded")) toggleExpanded(false);
  });
  window.addEventListener("resize", () => { fitExpandedCanvas(); clampView(canvasMetrics()); drawSky(); syncSideColumnHeight(); });
  window.addEventListener("orientationchange", () => setTimeout(() => { fitExpandedCanvas(); clampView(canvasMetrics()); drawSky(); }, 180));
}

async function init() {
  $("#timeInput").value = localInputValue(new Date());
  resetTimeline(selectedDate());
  try {
    const enabled = JSON.parse(localStorage.getItem("night-sky-satellites") || "null");
    if (Array.isArray(enabled) && enabled.length <= 8 && enabled.every((id) => Number.isInteger(id) && id > 0 && id <= 999999999)) {
      state.satellites.enabled = new Set(enabled);
    }
  } catch (_) { /* default China Space Station */ }
  try {
    const stored = JSON.parse(localStorage.getItem("night-sky-location") || "null");
    if (stored && Number.isFinite(stored.lat) && Number.isFinite(stored.lon)) setLocation(stored.lat, stored.lon, stored.elevation || 0);
  } catch (_) { /* ignore invalid local storage */ }
  if (!state.location) {
    $("#latInput").value = "0";
    $("#lonInput").value = "0";
  }
  updateLocationLabel();
  bindEvents();
  window.__skyReady = true;
  initInstallPrompt();
  updateViewUi();
  updateTrailNote();

  restoreCachedSky();
  if (!state.location) setManualOpen(true);
  refreshSky();
  // 首屏立即显示缓存或请求预览，定位独立进行。
  if (!state.location) {
    locateUser(true).then((located) => {
      if (!located) return;
      setManualOpen(false);
      refreshSky();
    });
  }
}

init();
