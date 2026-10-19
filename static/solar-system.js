const $ = (selector) => document.querySelector(selector);
const canvas = $("#orbitCanvas");
const ctx = canvas.getContext("2d");
const colors = {
  mercury: "#aab1bc", venus: "#c5a77c", earth: "#79a8f5", mars: "#db846e",
  jupiter: "#d5bd91", saturn: "#c4ad91", uranus: "#86c7c2", neptune: "#778ce0", pluto: "#9b8aaa",
};
const smallBodyColors = {
  bright_asteroid: "#d4aa63", neo: "#ef7f72", comet: "#73c8ce",
  meteor: "#c495ef", kbo: "#77a9df", tno: "#a48bd5",
};
const satellitePalette = ["#8fb5f3", "#cf9be8", "#e3a874", "#7dc6bc", "#efc86e", "#df8c9b", "#a7b875"];
const satellitePeriodsDays = {
  moon: 27.321661, phobos: .31891, deimos: 1.26244,
  io: 1.76914, europa: 3.55118, ganymede: 7.15455, callisto: 16.689,
  mimas: .94242, enceladus: 1.370218, tethys: 1.887802, dione: 2.736915,
  rhea: 4.518212, titan: 15.945421, iapetus: 79.3215,
  miranda: 1.413479, ariel: 2.520379, umbriel: 4.144177,
  titania: 8.705872, oberon: 13.463239, triton: -5.876854, charon: 6.38723,
};
const DAY_MS = 86_400_000;
const FULL_EXTENT_AU = 110;
const names = {
  mercury: "水星", venus: "金星", earth: "地球", mars: "火星", jupiter: "木星",
  saturn: "土星", uranus: "天王星", neptune: "海王星", pluto: "冥王星",
};
const innerIds = new Set(["mercury", "venus", "earth", "mars"]);
const state = {
  data: null,
  years: 1,
  positionsRequestId: 0,
  positionsAbort: null,
  view: "full",
  frame: "sun",
  viewMix: 0,
  frameMix: 0,
  orbitTransitionRaf: 0,
  orbitAnimating: false,
  cursor: 0,
  selected: "earth",
  playing: false,
  raf: 0,
  lastFrame: 0,
  satellites: [],
  zoom: 1,
  panX: 0,
  panY: 0,
  pointers: new Map(),
  gesture: null,
  dragged: false,
  satelliteTimer: 0,
  satelliteAbort: null,
  satelliteAt: null,
  satelliteRequestId: 0,
  satelliteRequestActive: false,
  satelliteRefreshQueued: false,
  lastSatelliteRequestAt: 0,
  satelliteFetched: false,
  lastPlaybackSatelliteUpdate: 0,
  satelliteHtml: "",
  layers: {
    bright_asteroid: true, neo: true, comet: true, meteor: false, kbo: true, tno: true,
  },
};

function localDateValue(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function parseLocalDateValue(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
      || date.getHours() !== hour || date.getMinutes() !== minute) return null;
  if (year < 1550 || date > new Date(2650, 0, 25, 23, 59)) return null;
  return date;
}

function displayDate(date) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function displayDateTime(date) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function currentDate() {
  if (!state.data) return new Date();
  const start = new Date(state.data.start).getTime();
  const end = new Date(state.data.end).getTime();
  const fraction = state.data.count > 1 ? state.cursor / (state.data.count - 1) : 1;
  return new Date(start + (end - start) * fraction);
}

function bodyPosition(body, cursor = state.cursor) {
  if (!body?.points?.length) return [0, 0, 0];
  const lower = Math.max(0, Math.min(body.points.length - 1, Math.floor(cursor)));
  const upper = Math.min(body.points.length - 1, lower + 1);
  const fraction = Math.max(0, Math.min(1, cursor - lower));
  return body.points[lower].map((value, axis) => value + (body.points[upper][axis] - value) * fraction);
}

function satelliteOrbitAxis(satellite) {
  if (satellite.orbit_axis) return satellite.orbit_axis;
  const [x, y, z] = satellite.relative;
  const velocity = satellite.relative_velocity;
  if (velocity?.length === 3) {
    const cross = [
      y * velocity[2] - z * velocity[1],
      z * velocity[0] - x * velocity[2],
      x * velocity[1] - y * velocity[0],
    ];
    const magnitude = Math.hypot(...cross);
    if (magnitude > 1e-15) return cross.map((value) => value / magnitude);
  }
  return [0, 0, Math.sign(satellitePeriodsDays[satellite.id]) || 1];
}

function rotateAroundAxis(vector, axis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dot = vector[0] * axis[0] + vector[1] * axis[1] + vector[2] * axis[2];
  const cross = [
    axis[1] * vector[2] - axis[2] * vector[1],
    axis[2] * vector[0] - axis[0] * vector[2],
    axis[0] * vector[1] - axis[1] * vector[0],
  ];
  return vector.map((value, index) =>
    value * cosine + cross[index] * sine + axis[index] * dot * (1 - cosine));
}

function satellitePositionsAtCursor() {
  if (!state.data || !state.satelliteAt || !state.satellites.length) return state.satellites;
  const start = new Date(state.data.start).getTime();
  const end = new Date(state.data.end).getTime();
  const span = end - start;
  if (!span) return state.satellites;
  const referenceCursor = ((state.satelliteAt - start) / span) * (state.data.count - 1);
  const elapsedDays = (currentDate().getTime() - state.satelliteAt) / DAY_MS;
  if (Math.abs(elapsedDays) < 1e-8) return state.satellites;
  const earthNow = earthPosition();
  return state.satellites.map((satellite) => {
    const period = satellitePeriodsDays[satellite.id];
    const parent = state.data.bodies.find((body) => body.id === satellite.parent);
    if (!period || !parent) return satellite;
    const axis = satelliteOrbitAxis(satellite);
    const angle = (2 * Math.PI * elapsedDays / Math.abs(period)) % (2 * Math.PI);
    const relative = rotateAroundAxis(satellite.relative, axis, angle);
    const parentAtReference = bodyPosition(parent, referenceCursor);
    const parentNow = bodyPosition(parent);
    const position = satellite.position.map((value, axis) =>
      value + parentNow[axis] - parentAtReference[axis] + relative[axis] - satellite.relative[axis]);
    const earthDistance = Math.hypot(...position.map((value, axis) => value - earthNow[axis]));
    return {
      ...satellite,
      orbit_axis: axis,
      relative,
      position,
      earth_distance: earthDistance,
      parent_distance_km: distanceAu(relative) * 149_597_870.7,
    };
  });
}

function distanceAu(position) {
  return Math.hypot(position[0], position[1], position[2]);
}

function earthDistanceAu(body, cursor = state.cursor) {
  if (body.id === "earth") return 0;
  if (body.earth_distances?.length) {
    const lower = Math.max(0, Math.min(body.earth_distances.length - 1, Math.floor(cursor)));
    const upper = Math.min(body.earth_distances.length - 1, lower + 1);
    const fraction = Math.max(0, Math.min(1, cursor - lower));
    return body.earth_distances[lower] + (body.earth_distances[upper] - body.earth_distances[lower]) * fraction;
  }
  return Number(body.earth_distance) || 0;
}

function selectedBody() {
  return state.data?.bodies.find((body) => body.id === state.selected)
    || state.data?.small_bodies?.find((body) => body.id === state.selected)
    || state.data?.meteor_streams?.find((body) => body.id === state.selected)
    || state.satellites.find((body) => body.id === state.selected)
    || state.data?.bodies.find((body) => body.id === "earth")
    || state.data?.bodies[0];
}

function bodyColor(body) {
  if (colors[body.id]) return colors[body.id];
  if (smallBodyColors[body.category]) return smallBodyColors[body.category];
  const siblings = state.satellites.filter((satellite) => satellite.parent === body.parent);
  return satellitePalette[Math.max(0, siblings.findIndex((satellite) => satellite.id === body.id)) % satellitePalette.length];
}

function selectedParentId() {
  const body = selectedBody();
  return body?.parent || body?.id || "earth";
}

function visibleBodies() {
  if (!state.data) return [];
  const innerOnly = state.view === "inner" && state.viewMix >= .999;
  const planets = innerOnly
    ? state.data.bodies.filter((body) => innerIds.has(body.id))
    : state.data.bodies;
  const smallBodies = (state.data.small_bodies || []).filter((body) => {
    if (!state.layers[body.category]) return false;
    return !innerOnly || body.category === "neo";
  });
  const streams = state.layers.meteor ? (state.data.meteor_streams || []) : [];
  return [...planets, ...smallBodies, ...streams];
}

function earthPosition(cursor = state.cursor) {
  const earth = state.data?.bodies.find((body) => body.id === "earth");
  return earth ? bodyPosition(earth, cursor) : [0, 0, 0];
}

function positionInFrame(position, cursor = state.cursor) {
  if (state.frameMix <= .001) return position;
  const earth = earthPosition(cursor);
  return position.map((value, axis) => value - earth[axis] * state.frameMix);
}

function bodyPoint(body, metrics, cursor = state.cursor) {
  return plotPoint(positionInFrame(bodyPosition(body, cursor), cursor), metrics);
}

function updateViewNote() {
  // 视图状态已经由按钮本身表达，不再重复显示副标题。
}

function syncOrbitToggleButtons() {
  const frameButton = $("#frameButtons button");
  const scaleButton = $("#scaleButtons button");
  frameButton.dataset.frame = state.frame;
  const frameLabel = frameButton.querySelector("span");
  const scaleLabel = scaleButton.querySelector("span");
  frameLabel.textContent = state.frame === "sun" ? "日心" : "地心";
  frameButton.setAttribute("aria-label", `${state.frame === "sun" ? "日心" : "地心"}视图，点击切换`);
  scaleButton.dataset.view = state.view;
  scaleLabel.textContent = state.view === "full" ? "全太阳系" : "内太阳系";
  scaleButton.setAttribute("aria-label", `${state.view === "full" ? "全太阳系" : "内太阳系"}，点击切换`);
}

function animateOrbitSwitch() {
  cancelAnimationFrame(state.orbitTransitionRaf);
  const fromView = state.viewMix;
  const fromFrame = state.frameMix;
  const toView = state.view === "inner" ? 1 : 0;
  const toFrame = state.frame === "earth" ? 1 : 0;
  state.orbitAnimating = true;
  let lastFrame = performance.now();
  let animationTime = 0;
  const duration = 920;
  const step = (now) => {
    animationTime += Math.min(40, Math.max(0, now - lastFrame));
    lastFrame = now;
    const progress = Math.min(1, animationTime / duration);
    const eased = progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    state.viewMix = fromView + (toView - fromView) * eased;
    state.frameMix = fromFrame + (toFrame - fromFrame) * eased;
    draw();
    if (progress < 1) state.orbitTransitionRaf = requestAnimationFrame(step);
    else {
      state.orbitAnimating = false;
      state.orbitTransitionRaf = 0;
      draw();
      renderPlanetList();
    }
  };
  state.orbitTransitionRaf = requestAnimationFrame(step);
}

function plotPoint(position, metrics) {
  const [x, y] = position;
  const radiusAu = Math.hypot(x, y);
  const angle = Math.atan2(y, x);
  const scaled = radialScale(radiusAu);
  const radial = metrics.radius * scaled;
  const x0 = metrics.cx + Math.cos(angle) * radial;
  const y0 = metrics.cy - Math.sin(angle) * radial;
  return {
    x: metrics.cx + (x0 - metrics.cx) * state.zoom + state.panX,
    y: metrics.cy + (y0 - metrics.cy) * state.zoom + state.panY,
  };
}

function radialScale(radiusAu) {
  const innerLimit = 1.8 + (3.2 - 1.8) * state.frameMix;
  const innerScale = Math.min(1, radiusAu / innerLimit);
  const fullScale = Math.min(1, Math.log1p(radiusAu) / Math.log1p(FULL_EXTENT_AU));
  return fullScale + (innerScale - fullScale) * state.viewMix;
}

function canvasMetrics() {
  const rect = canvas.getBoundingClientRect();
  const toolbar = $(".orbit-controls-overlay");
  const timeline = $(".orbit-panel .timeline");
  const toolbarRect = toolbar?.getBoundingClientRect();
  const timelineRect = timeline?.getBoundingClientRect();
  const controlsBottom = toolbarRect?.height ? toolbarRect.bottom - rect.top + 8 : 0;
  const controlsTop = timelineRect?.height ? timelineRect.top - rect.top - 10 : rect.height;
  const visibleTop = Math.max(0, Math.min(rect.height * .25, controlsBottom));
  const visibleBottom = Math.max(visibleTop + rect.height * .42, Math.min(rect.height, controlsTop));
  const visibleHeight = visibleBottom - visibleTop;
  const radius = Math.min(rect.width, visibleHeight) * .425;
  return { rect, width: rect.width, height: rect.height, cx: rect.width / 2, cy: visibleTop + visibleHeight / 2, radius };
}

function makeBeltSeeds(count, minRadius, maxRadius, seed) {
  let value = seed >>> 0;
  const random = () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    radius: minRadius + (maxRadius - minRadius) * random(),
    angle: random() * Math.PI * 2,
    alpha: .14 + random() * .27,
    size: .35 + random() * .65,
  }));
}

const mainBeltSeeds = makeBeltSeeds(260, 2.08, 3.32, 314159);
const kuiperBeltSeeds = makeBeltSeeds(210, 30, 50, 271828);

function drawBelt(metrics, seeds, color) {
  const days = currentDate().getTime() / DAY_MS;
  ctx.save();
  ctx.fillStyle = color;
  seeds.forEach((item, index) => {
    if (state.orbitAnimating && index % 3 !== 0) return;
    const periodDays = 365.256 * Math.pow(item.radius, 1.5);
    const angle = item.angle + days / periodDays * Math.PI * 2;
    const position = [Math.cos(angle) * item.radius, Math.sin(angle) * item.radius, 0];
    const point = plotPoint(positionInFrame(position), metrics);
    ctx.globalAlpha = item.alpha;
    ctx.fillRect(point.x, point.y, item.size, item.size);
  });
  ctx.restore();
}

function drawBelts(metrics) {
  if (state.view === "inner" && state.viewMix >= .999) return;
  if (state.layers.bright_asteroid) drawBelt(metrics, mainBeltSeeds, "#d4aa63");
  if (state.layers.kbo) drawBelt(metrics, kuiperBeltSeeds, "#77a9df");
}

function drawReference(metrics) {
  const cx = metrics.cx + state.panX;
  const cy = metrics.cy + state.panY;
  const radius = metrics.radius * state.zoom;
  ctx.save();
  ctx.strokeStyle = "rgba(148, 163, 184, .13)";
  ctx.fillStyle = "rgba(119, 131, 147, .7)";
  ctx.lineWidth = 1;
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "left";
  const rings = state.view === "inner"
    ? (state.frame === "earth" ? [.5, 1, 2, 3] : [.5, 1, 1.5])
      .map((au) => ({ au, fraction: radialScale(au) }))
    : [1, 5, 10, 30, 50, 100].map((au) => ({ au, fraction: radialScale(au) }));
  rings.forEach(({ au, fraction }) => {
    const ringRadius = radius * fraction;
    ctx.beginPath(); ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(`${au} AU`, cx + 5, cy - ringRadius - 4);
  });
  ctx.setLineDash([2, 7]);
  ctx.strokeStyle = "rgba(148, 163, 184, .08)";
  ctx.beginPath(); ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function orbitPointAt(body, index, metrics, earth) {
  const lower = Math.max(0, Math.min(body.points.length - 1, Math.floor(index)));
  const upper = Math.min(body.points.length - 1, lower + 1);
  const fraction = Math.max(0, Math.min(1, index - lower));
  const position = body.points[lower].map((value, axis) => value + (body.points[upper][axis] - value) * fraction);
  if (earth) {
    const earthPosition = earth.points[lower].map((value, axis) => value + (earth.points[upper][axis] - value) * fraction);
    return plotPoint(position.map((value, axis) => value - earthPosition[axis] * state.frameMix), metrics);
  }
  return plotPoint(position, metrics);
}

function drawOrbitSection(body, metrics, earth, start, end) {
  if (end <= start) return;
  ctx.beginPath();
  const first = orbitPointAt(body, start, metrics, earth);
  ctx.moveTo(first.x, first.y);
  if (state.orbitAnimating) {
    const samples = Math.max(2, Math.min(body.category ? 28 : 64, Math.ceil(end - start)));
    for (let step = 1; step <= samples; step += 1) {
      const point = orbitPointAt(body, start + (end - start) * step / samples, metrics, earth);
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    return;
  }
  for (let index = Math.floor(start) + 1; index <= Math.floor(end); index += 1) {
    const point = orbitPointAt(body, index, metrics, earth);
    ctx.lineTo(point.x, point.y);
  }
  const last = orbitPointAt(body, end, metrics, earth);
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawOrbit(body, metrics, emphasized) {
  if ((state.frame === "earth" && state.frameMix >= .999 && body.id === "earth") || body.points.length < 2) return;
  const earth = state.frameMix > .001 ? state.data.bodies.find((item) => item.id === "earth") : null;
  const selected = body.id === state.selected || body.id === selectedParentId();
  const smallBody = Boolean(body.category);
  const pastEnd = Math.max(0, Math.min(body.points.length - 1, state.cursor));
  const lastIndex = body.points.length - 1;
  ctx.save();
  ctx.strokeStyle = selected ? bodyColor(body) : smallBody ? bodyColor(body) : emphasized ? "rgba(148, 163, 184, .09)" : "rgba(148, 163, 184, .17)";
  ctx.lineWidth = selected ? 1.9 : smallBody ? .7 : emphasized ? .75 : 1;
  ctx.globalAlpha = selected ? .94 : smallBody ? (body.category === "meteor" ? .24 : .19) : emphasized ? .45 : .76;
  if (body.category === "meteor") ctx.setLineDash([5, 6]);
  if (selected) { ctx.shadowColor = bodyColor(body); ctx.shadowBlur = 7; }
  drawOrbitSection(body, metrics, earth, 0, pastEnd);
  if (pastEnd < lastIndex) {
    ctx.setLineDash([2, 4]);
    ctx.globalAlpha = selected ? .62 : emphasized ? .2 : .3;
    ctx.shadowBlur = 0;
    drawOrbitSection(body, metrics, earth, pastEnd, lastIndex);
  }
  ctx.restore();
}

function drawPlanets(metrics) {
  const bodies = visibleBodies();
  bodies.forEach((body) => {
    if (state.frame === "earth" && state.frameMix >= .999 && body.id === "earth") return;
    const position = bodyPosition(body);
    const point = plotPoint(positionInFrame(position), metrics);
    const selected = body.id === state.selected || body.id === selectedParentId();
    const focused = body.id === selectedParentId();
    const smallBody = Boolean(body.category);
    const size = smallBody ? (body.category === "comet" ? 2.3 : 1.9) : body.id === "jupiter" ? 5.2 : body.id === "saturn" ? 4.8 : 3.7;
    ctx.globalAlpha = focused ? 1 : smallBody ? .72 : .55;
    if (selected) {
      ctx.beginPath(); ctx.arc(point.x, point.y, size + 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(235, 240, 249, .72)"; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(point.x, point.y, selected ? size + .7 : size, 0, Math.PI * 2);
    ctx.fillStyle = bodyColor(body);
    ctx.shadowColor = bodyColor(body);
    ctx.shadowBlur = selected ? 12 : 5;
    ctx.fill(); ctx.shadowBlur = 0;

    const labelOffset = {
      mercury: [-11, -13], venus: [8, -12], earth: [9, 13], mars: [-9, 16],
      jupiter: [9, -12], saturn: [9, 14], uranus: [-9, -13], neptune: [9, 13], pluto: [-9, -13],
    }[body.id] || [8, -8];
    if (!smallBody || selected) {
      ctx.font = selected ? "11px system-ui, sans-serif" : "10px system-ui, sans-serif";
      ctx.fillStyle = selected ? "#f1f3f6" : "rgba(177, 187, 200, .82)";
      ctx.textAlign = labelOffset[0] < 0 ? "right" : "left";
      ctx.textBaseline = "middle";
      ctx.fillText(names[body.id] || body.name, point.x + labelOffset[0], point.y + labelOffset[1]);
    }
    ctx.globalAlpha = 1;
  });
}

function satelliteScreenPoint(satellite, metrics, siblings = state.satellites) {
  const parent = state.data?.bodies.find((body) => body.id === satellite.parent);
  if (!parent) return null;
  const parentPoint = bodyPoint(parent, metrics);
  const parentSatellites = siblings.filter((item) => item.parent === satellite.parent);
  const maxDistance = Math.max(1, ...parentSatellites.map((item) => item.parent_distance_km));
  const groupRadius = {
    earth: 11, mars: 13, jupiter: 19, saturn: 22,
    uranus: 16, neptune: 13, pluto: 11,
  }[satellite.parent] || 12;
  const distanceRatio = Math.sqrt(Math.min(1, satellite.parent_distance_km / maxDistance));
  const radius = 7 + distanceRatio * (groupRadius - 7);
  const angle = Math.atan2(satellite.relative[1], satellite.relative[0]);
  return {
    x: parentPoint.x + Math.cos(angle) * radius,
    y: parentPoint.y - Math.sin(angle) * radius,
    radius,
    center: parentPoint,
  };
}

function drawSatelliteOrbits(metrics) {
  const innerOnly = state.view === "inner" && state.viewMix >= .999;
  const visibleSatellites = satellitePositionsAtCursor().filter((satellite) => !innerOnly || innerIds.has(satellite.parent));
  const selectedSatellite = visibleSatellites.find((satellite) => satellite.id === state.selected);
  const focusParent = selectedSatellite?.parent || selectedParentId();
  visibleSatellites.forEach((satellite) => {
    const point = satelliteScreenPoint(satellite, metrics, visibleSatellites);
    if (!point) return;
    const selected = satellite.id === state.selected;
    const focused = satellite.parent === focusParent;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.center.x, point.center.y, point.radius, 0, Math.PI * 2);
    ctx.strokeStyle = focused ? `${bodyColor(satellite)}88` : "rgba(148, 163, 184, .13)";
    ctx.lineWidth = selected ? 1.4 : focused ? 1 : .75;
    ctx.globalAlpha = focused ? .85 : .55;
    ctx.setLineDash(selected ? [] : [2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(point.x, point.y, selected ? 3.8 : focused ? 2.5 : 1.9, 0, Math.PI * 2);
    ctx.fillStyle = bodyColor(satellite);
    ctx.globalAlpha = selected ? 1 : focused ? .9 : .48;
    if (selected) { ctx.shadowColor = bodyColor(satellite); ctx.shadowBlur = 9; }
    ctx.fill();
    ctx.restore();
    if (selected) {
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = "#edf1f6";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(satellite.name, point.x + 7, point.y - 8);
    }
  });
}

function drawOrigin(metrics) {
  const center = { x: metrics.cx + state.panX, y: metrics.cy + state.panY };
  const point = plotPoint(positionInFrame([0, 0, 0]), metrics);
  ctx.beginPath(); ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(244, 207, 123, .14)"; ctx.fill();
  ctx.beginPath(); ctx.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = "#f2d68c"; ctx.shadowColor = "rgba(242, 214, 140, .65)"; ctx.shadowBlur = 11; ctx.fill(); ctx.shadowBlur = 0;
  if (state.frameMix > .001) {
    ctx.beginPath(); ctx.arc(center.x, center.y, 6 * state.frameMix, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(121, 168, 245, .15)"; ctx.fill();
    ctx.beginPath(); ctx.arc(center.x, center.y, 3.1 * state.frameMix, 0, Math.PI * 2);
    ctx.fillStyle = colors.earth; ctx.fill();
    if (state.frameMix > .65) {
      ctx.fillStyle = "#a9c3f5"; ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText("地球", center.x + 9, center.y + 10);
    }
  }
  ctx.fillStyle = "#858d98"; ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText("黄道北极", 11, 11);
}

function draw() {
  if (!state.data) return;
  const metrics = canvasMetrics();
  const { width, height } = metrics;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const background = ctx.createRadialGradient(metrics.cx, metrics.cy, 0, metrics.cx, metrics.cy, metrics.radius * 1.25);
  background.addColorStop(0, "#111820");
  background.addColorStop(1, "#0b0f13");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  drawReference(metrics);
  drawBelts(metrics);
  const bodies = visibleBodies();
  const focusId = selectedParentId();
  const selectedVisible = bodies.some((body) => body.id === focusId);
  bodies.forEach((body) => drawOrbit(body, metrics, selectedVisible && body.id !== focusId));
  drawPlanets(metrics);
  drawSatelliteOrbits(metrics);
  drawOrigin(metrics);
}

function renderTimeline() {
  if (!state.data) return;
  const start = new Date(state.data.start);
  const end = new Date(state.data.end);
  const date = currentDate();
  $("#timelineStart").textContent = displayDate(start);
  $("#timelineEnd").textContent = displayDate(end);
  $("#cursorDate").textContent = displayDateTime(date);
  $("#anchorDate").value = localDateValue(date);
  $("#timeSlider").max = String(Math.max(1, state.data.count - 1));
  $("#timeSlider").value = String(state.cursor);
  const step = state.data.step_days;
  $("#sampleNote").textContent = step <= 1.01 ? "每日采样" : `约每 ${Math.round(step)} 天采样`;
}

function enabledSmallBodies() {
  if (!state.data) return [];
  return [...(state.data.small_bodies || []), ...(state.data.meteor_streams || [])]
    .filter((body) => state.layers[body.category]);
}

function renderSmallBodyList() {
  const list = $("#smallBodyList");
  if (!list || !state.data) return;
  const bodies = enabledSmallBodies();
  $("#smallBodyCount").textContent = String(bodies.length);
  const signature = bodies.map((body) => body.id).join(",");
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.innerHTML = bodies.length ? bodies.map((body) => `<button class="small-body-row" data-id="${body.id}">
      <span class="small-body-dot" style="background:${bodyColor(body)}"></span>
      <span><span class="small-body-name">${body.name}</span><span class="small-body-kind">${body.kind} · ${body.designation}</span></span>
      <span class="small-body-distance">— AU</span>
    </button>`).join("") : '<div class="satellite-empty">请在上方开启一个图层。</div>';
    list.querySelectorAll(".small-body-row").forEach((row) => row.addEventListener("click", () => selectBody(row.dataset.id)));
  }
  bodies.forEach((body) => {
    const row = list.querySelector(`[data-id="${body.id}"]`);
    if (!row) return;
    row.classList.toggle("active", body.id === state.selected);
    row.querySelector(".small-body-distance").textContent = `${earthDistanceAu(body).toFixed(2)} AU`;
  });
}

function renderPlanetList() {
  if (!state.data) return;
  const currentSatellites = satellitePositionsAtCursor();
  const list = $("#planetList");
  if (list.children.length !== state.data.bodies.length) {
    list.innerHTML = state.data.bodies.map((body) => `<button class="planet-row" data-id="${body.id}">
      <span class="planet-dot" style="background:${colors[body.id]}"></span>
      <span><span class="planet-row-name">${names[body.id] || body.name}</span><span class="planet-row-kind">${body.kind}</span></span>
      <span class="planet-row-distance"><span>— <small>日心</small></span><span>— <small>地球</small></span></span>
    </button>`).join("");
    list.querySelectorAll(".planet-row").forEach((row) => row.addEventListener("click", () => selectBody(row.dataset.id)));
  }
  const parentId = selectedParentId();
  state.data.bodies.forEach((body) => {
    const row = list.querySelector(`[data-id="${body.id}"]`);
    if (!row) return;
    row.classList.toggle("active", body.id === state.selected || body.id === parentId);
    const distances = row.querySelectorAll(".planet-row-distance span");
    const solarDistance = `${distanceAu(bodyPosition(body)).toFixed(2)} `;
    const geocentricDistance = `${earthDistanceAu(body).toFixed(2)} `;
    if (distances[0].firstChild.textContent !== solarDistance) distances[0].firstChild.textContent = solarDistance;
    if (distances[1].firstChild.textContent !== geocentricDistance) distances[1].firstChild.textContent = geocentricDistance;
  });
  renderSmallBodyList();
  const selected = selectedBody();
  const body = currentSatellites.find((item) => item.id === selected?.id) || selected;
  if (!body) return;
  const position = body.position || bodyPosition(body);
  $("#selectedColor").style.background = bodyColor(body);
  $("#selectedName").textContent = names[body.id] || body.name;
  $("#selectedDistance").textContent = distanceAu(position).toFixed(3);
  $("#selectedEarthDistance").textContent = earthDistanceAu(body).toFixed(body.id === "earth" ? 2 : 3);
  $("#selectedX").textContent = position[0].toFixed(3);
  $("#selectedY").textContent = position[1].toFixed(3);
  $("#selectedZ").textContent = position[2].toFixed(3);

  const parent = state.data.bodies.find((item) => item.id === parentId);
  const satellites = currentSatellites.filter((item) => item.parent === parentId);
  const satelliteRows = state.satellites.filter((item) => item.parent === parentId);
  $("#satelliteCaption").textContent = parent ? `${names[parent.id] || parent.name} · ${satellites.length} 颗可见` : "选择行星查看其卫星";
  $("#satelliteStatus").textContent = !state.satelliteFetched
    ? "位置更新中"
    : state.satellites.length
      ? `当前 ${state.satellites.length} 颗`
      : state.data.satellite_count > 1 ? "所选日期暂无卫星位置" : "行星卫星星历未载入";
  const satelliteHtml = satelliteRows.length
    ? satelliteRows.map((satellite, index) => `<button class="satellite-row${satellite.id === state.selected ? " active" : ""}" data-id="${satellite.id}">
        <span class="satellite-dot" style="background:${satellitePalette[index % satellitePalette.length]}"></span>
        <span><span class="satellite-row-name">${satellite.name}</span><span class="satellite-row-info">绕行 ${formatKm(satellite.parent_distance_km)}</span></span>
        <span class="satellite-row-distance">距地球 ${satellite.earth_distance.toFixed(2)} AU</span>
      </button>`).join("")
    : `<div class="satellite-empty">${!state.satelliteFetched ? "正在读取所选日期的卫星位置…" : state.data.satellite_count > 1 ? "所选日期或所选行星没有可用的卫星位置。" : "卫星数据由 JPL SPK 星历提供。当前仅有月球轨道数据。"}</div>`;
  if (satelliteHtml !== state.satelliteHtml) {
    $("#satelliteList").innerHTML = satelliteHtml;
    state.satelliteHtml = satelliteHtml;
    $("#satelliteList").querySelectorAll(".satellite-row").forEach((row) => row.addEventListener("click", () => selectBody(row.dataset.id)));
  }
  drawSatelliteDiagram(satellites);
}

function formatKm(kilometers) {
  if (kilometers >= 1000000) return `${(kilometers / 10000).toFixed(1)} 万 km`;
  if (kilometers >= 10000) return `${(kilometers / 1000).toFixed(0)} 千 km`;
  return `${Math.round(kilometers).toLocaleString("zh-CN")} km`;
}

function drawSatelliteDiagram(satellites) {
  const target = $("#satelliteCanvas");
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);
  if (target.width !== pixelWidth) target.width = pixelWidth;
  if (target.height !== pixelHeight) target.height = pixelHeight;
  const drawing = target.getContext("2d");
  drawing.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawing.clearRect(0, 0, rect.width, rect.height);
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const outerRadius = Math.max(18, Math.min(rect.width * .43, rect.height * .40));
  drawing.fillStyle = "#0b0f13";
  drawing.fillRect(0, 0, rect.width, rect.height);
  const maxDistance = Math.max(0, ...satellites.map((item) => item.parent_distance_km));
  if (!satellites.length || !maxDistance) {
    drawing.fillStyle = "#566170";
    drawing.font = "9px system-ui, sans-serif";
    drawing.textAlign = "center";
    drawing.textBaseline = "middle";
    drawing.fillText("此处显示所选天体卫星的相对位置", cx, cy);
    return;
  }
  satellites.forEach((satellite, index) => {
    const ratio = outerRadius / (maxDistance / 149597870.7);
    const axis = satelliteOrbitAxis(satellite);
    drawing.beginPath();
    for (let step = 0; step <= 72; step += 1) {
      const orbitPoint = rotateAroundAxis(satellite.relative, axis, step / 72 * Math.PI * 2);
      const orbitX = cx + orbitPoint[0] * ratio;
      const orbitY = cy - orbitPoint[1] * ratio;
      if (step === 0) drawing.moveTo(orbitX, orbitY); else drawing.lineTo(orbitX, orbitY);
    }
    drawing.closePath();
    drawing.strokeStyle = "rgba(148, 163, 184, .12)";
    drawing.lineWidth = 1;
    drawing.stroke();
    const [xAu, yAu] = satellite.relative;
    const x = cx + xAu * ratio;
    const y = cy - yAu * ratio;
    drawing.beginPath();
    drawing.arc(x, y, satellite.id === state.selected ? 3.5 : 2.5, 0, Math.PI * 2);
    drawing.fillStyle = satellitePalette[index % satellitePalette.length];
    drawing.shadowColor = drawing.fillStyle;
    drawing.shadowBlur = satellite.id === state.selected ? 7 : 3;
    drawing.fill();
    drawing.shadowBlur = 0;
  });
  drawing.beginPath();
  drawing.arc(cx, cy, 3, 0, Math.PI * 2);
  drawing.fillStyle = "#f2d68c";
  drawing.fill();
}

function render() {
  draw();
  renderTimeline();
  renderPlanetList();
}

function selectBody(id) {
  const body = state.data?.bodies.find((item) => item.id === id)
    || state.data?.small_bodies?.find((item) => item.id === id)
    || state.data?.meteor_streams?.find((item) => item.id === id)
    || state.satellites.find((item) => item.id === id);
  if (!body) return;
  const hostId = body.parent || body.id;
  if (state.view === "inner" && !innerIds.has(hostId)) {
    state.view = "full";
    syncOrbitToggleButtons();
    animateOrbitSwitch();
    updateViewNote();
  }
  state.selected = id;
  render();
}

async function loadPositions({ focusDate, years = state.years } = {}) {
  const focus = focusDate || parseLocalDateValue($("#anchorDate").value) || new Date();
  const requestId = ++state.positionsRequestId;
  state.positionsAbort?.abort();
  const controller = new AbortController();
  state.positionsAbort = controller;
  state.years = years;
  stopPlayback();
  clearTimeout(state.satelliteTimer);
  state.satelliteTimer = 0;
  state.satelliteAbort?.abort();
  state.satelliteAbort = null;
  state.satelliteRequestId += 1;
  state.satelliteRequestActive = false;
  state.satelliteRefreshQueued = false;
  state.satellites = [];
  state.satelliteAt = null;
  state.satelliteFetched = false;
  $("#orbitLoading").hidden = false;
  $("#orbitLoading").textContent = "正在计算行星位置…";
  try {
    const url = new URL("/api/solar-system", window.location.origin);
    url.searchParams.set("focus", focus.toISOString());
    url.searchParams.set("years", String(years));
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (requestId !== state.positionsRequestId) return;
    if (!response.ok) throw new Error(data.detail || "太阳系位置计算失败。");
    state.data = data;
    state.years = years;
    state.cursor = Math.max(0, Math.min(data.count - 1, data.past_fraction * (data.count - 1)));
    updateViewNote();
    $("#orbitLoading").hidden = true;
    render();
    refreshSatellitePositions();
  } catch (error) {
    if (requestId !== state.positionsRequestId || error.name === "AbortError") return;
    $("#orbitLoading").hidden = true;
    $("#orbitLoading").textContent = error.message || "太阳系位置计算失败。";
    $("#orbitLoading").hidden = false;
  } finally {
    if (requestId === state.positionsRequestId) state.positionsAbort = null;
  }
}

function stopPlayback() {
  state.playing = false;
  cancelAnimationFrame(state.raf);
  $("#playBtn").innerHTML = "▶ <span>播放</span>";
  $("#playBtn").setAttribute("aria-label", "播放行星运行");
}

function animate(timestamp) {
  if (!state.playing || !state.data) return;
  if (!state.lastFrame) state.lastFrame = timestamp;
  const elapsed = Math.min(100, timestamp - state.lastFrame);
  state.lastFrame = timestamp;
  const daysPerSecond = Number($("#speedSelect").value) || 7;
  const increment = (elapsed / 1000 * daysPerSecond) / state.data.step_days;
  state.cursor = Math.min(state.data.count - 1, state.cursor + increment);
  render();
  if (timestamp - state.lastPlaybackSatelliteUpdate > 650) {
    state.lastPlaybackSatelliteUpdate = timestamp;
    refreshSatellitePositions();
  }
  if (state.cursor >= state.data.count - 1) {
    stopPlayback();
    return;
  }
  state.raf = requestAnimationFrame(animate);
}

function togglePlayback() {
  if (!state.data) return;
  if (state.playing) { stopPlayback(); return; }
  if (state.cursor >= state.data.count - 1) {
    state.cursor = state.data.past_fraction * (state.data.count - 1);
    render();
  }
  state.playing = true;
  state.lastFrame = 0;
  $("#playBtn").innerHTML = "Ⅱ <span>暂停</span>";
  $("#playBtn").setAttribute("aria-label", "暂停行星运行");
  state.raf = requestAnimationFrame(animate);
}

function bindEvents() {
  $("#minorLayerButtons").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-layer]");
    if (!button) return;
    const layer = button.dataset.layer;
    state.layers[layer] = !state.layers[layer];
    button.classList.toggle("active", state.layers[layer]);
    button.setAttribute("aria-pressed", String(state.layers[layer]));
    const selected = selectedBody();
    if (selected?.category === layer && !state.layers[layer]) state.selected = "earth";
    render();
  });
  $("#rangeButtons").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-years]");
    if (!button) return;
    document.querySelectorAll("#rangeButtons button").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    loadPositions({ focusDate: parseLocalDateValue($("#anchorDate").value) || new Date(), years: Number(button.dataset.years) });
  });
  $("#scaleButtons").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button) return;
    state.view = state.view === "full" ? "inner" : "full";
    syncOrbitToggleButtons();
    updateViewNote();
    draw();
    animateOrbitSwitch();
  });
  $("#frameButtons").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-frame]");
    if (!button) return;
    state.frame = state.frame === "sun" ? "earth" : "sun";
    syncOrbitToggleButtons();
    updateViewNote();
    draw();
    animateOrbitSwitch();
  });
  $("#anchorDate").addEventListener("change", () => {
    const date = parseLocalDateValue($("#anchorDate").value);
    if (!date) {
      $("#anchorDate").value = localDateValue(currentDate());
      return;
    }
    $("#anchorDate").value = localDateValue(date);
    loadPositions({ focusDate: date, years: state.years });
  });
  $("#todayBtn").addEventListener("click", () => {
    const now = new Date();
    $("#anchorDate").value = localDateValue(now);
    loadPositions({ focusDate: now, years: state.years });
  });
  $("#timeSlider").addEventListener("input", (event) => {
    stopPlayback();
    state.cursor = Number(event.target.value);
    render();
  });
  $("#timeSlider").addEventListener("change", refreshSatellitePositions);
  $("#playBtn").addEventListener("click", togglePlayback);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    setZoom(state.zoom * (event.deltaY < 0 ? 1.14 : 1 / 1.14), {
      x: event.clientX - rect.left, y: event.clientY - rect.top,
    });
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 2) {
      const points = [...state.pointers.values()];
      state.gesture = {
        mode: "pinch", startDistance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
        startZoom: state.zoom, startPanX: state.panX, startPanY: state.panY,
        startMid: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
      };
    } else {
      state.gesture = { mode: "drag", startX: event.clientX, startY: event.clientY, startPanX: state.panX, startPanY: state.panY };
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size >= 2 && state.gesture?.mode === "pinch") {
      const points = [...state.pointers.values()];
      const distance = Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y));
      const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const nextZoom = Math.max(.8, Math.min(16, state.gesture.startZoom * distance / state.gesture.startDistance));
      state.panX = state.gesture.startPanX + midpoint.x - state.gesture.startMid.x;
      state.panY = state.gesture.startPanY + midpoint.y - state.gesture.startMid.y;
      state.zoom = nextZoom;
      state.dragged = true;
      canvas.classList.add("is-dragging");
      draw();
    } else if (state.pointers.size === 1 && state.gesture?.mode === "drag" && state.zoom > 1) {
      const dx = event.clientX - state.gesture.startX;
      const dy = event.clientY - state.gesture.startY;
      if (Math.hypot(dx, dy) > 4) {
        state.panX = state.gesture.startPanX + dx;
        state.panY = state.gesture.startPanY + dy;
        state.dragged = true;
        canvas.classList.add("is-dragging");
        draw();
      }
    }
  });
  const finishPointer = (event) => {
    state.pointers.delete(event.pointerId);
    canvas.classList.remove("is-dragging");
    if (state.pointers.size === 0) {
      state.gesture = null;
      if (state.dragged) window.setTimeout(() => { state.dragged = false; }, 280);
    }
    else if (state.pointers.size === 1) {
      const point = [...state.pointers.values()][0];
      state.gesture = { mode: "drag", startX: point.x, startY: point.y, startPanX: state.panX, startPanY: state.panY };
    }
  };
  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);
  canvas.addEventListener("click", (event) => {
    if (state.dragged) { state.dragged = false; return; }
    const metrics = canvasMetrics();
    const x = event.clientX - metrics.rect.left;
    const y = event.clientY - metrics.rect.top;
    let best = window.matchMedia("(pointer: coarse)").matches ? 28 : 20;
    let target = null;
    visibleBodies().forEach((body) => {
      const point = bodyPoint(body, metrics);
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < best) { best = distance; target = body.id; }
    });
    const currentSatellites = satellitePositionsAtCursor();
    currentSatellites.forEach((satellite) => {
      if (state.view === "inner" && state.viewMix >= .999 && !innerIds.has(satellite.parent)) return;
      const point = satelliteScreenPoint(satellite, metrics, currentSatellites);
      if (!point) return;
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < best) { best = distance; target = satellite.id; }
    });
    if (target) selectBody(target);
  });
  window.addEventListener("resize", () => { draw(); renderPlanetList(); });
}

function setZoom(value, anchor = null) {
  const oldZoom = state.zoom;
  const nextZoom = Math.max(.8, Math.min(16, value));
  const metrics = canvasMetrics();
  if (anchor) {
    const baseX = (anchor.x - metrics.cx - state.panX) / oldZoom + metrics.cx;
    const baseY = (anchor.y - metrics.cy - state.panY) / oldZoom + metrics.cy;
    state.panX = anchor.x - metrics.cx - (baseX - metrics.cx) * nextZoom;
    state.panY = anchor.y - metrics.cy - (baseY - metrics.cy) * nextZoom;
  }
  state.zoom = nextZoom;
  if (state.zoom <= 1) { state.zoom = 1; state.panX = 0; state.panY = 0; }
  draw();
}

function refreshSatellitePositions() {
  if (!state.data) return;
  state.satelliteRefreshQueued = true;
  if (state.satelliteRequestActive || state.satelliteTimer) return;
  const interval = state.playing ? 650 : 140;
  const elapsed = performance.now() - state.lastSatelliteRequestAt;
  const delay = Math.max(0, interval - elapsed);
  state.satelliteTimer = window.setTimeout(fetchLatestSatellitePositions, delay);
}

async function fetchLatestSatellitePositions() {
  state.satelliteTimer = 0;
  if (!state.data || !state.satelliteRefreshQueued || state.satelliteRequestActive) return;
  state.satelliteRefreshQueued = false;
  state.satelliteRequestActive = true;
  state.lastSatelliteRequestAt = performance.now();
  const requestId = ++state.satelliteRequestId;
  const controller = new AbortController();
  state.satelliteAbort = controller;
  const url = new URL("/api/solar-system/satellites", window.location.origin);
  url.searchParams.set("at", currentDate().toISOString());
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "卫星位置载入失败");
    if (requestId !== state.satelliteRequestId) return;
    state.satellites = data.satellites || [];
    state.satelliteAt = new Date(data.at).getTime();
    state.satelliteFetched = true;
    draw();
    renderPlanetList();
  } catch (error) {
    if (error.name !== "AbortError" && requestId === state.satelliteRequestId) {
      $("#satelliteStatus").textContent = "卫星位置载入失败";
    }
  } finally {
    if (requestId === state.satelliteRequestId) {
      state.satelliteAbort = null;
      state.satelliteRequestActive = false;
      if (state.satelliteRefreshQueued) refreshSatellitePositions();
    }
  }
}

async function init() {
  const now = new Date();
  $("#anchorDate").value = localDateValue(now);
  bindEvents();
  await loadPositions({ focusDate: now, years: 1 });
}

init();
