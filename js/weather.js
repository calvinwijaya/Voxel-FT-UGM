// =====================================================================
//  WEATHER & AIR QUALITY — Open-Meteo (free, no key, CORS), every 15 min
//   • forecast API: current conditions + next hours
//   • air-quality API: CAMS model (US AQI, PM2.5, PM10, O3, NO2, SO2, CO)
//   • optional WAQI station reading if CONFIG.WEATHER.waqiToken is set
//  Emits:  'weather-data' (detail = current)   'weather-effect' (visuals changed)
// =====================================================================
(function () {
    const $ = id => document.getElementById(id);
    const W = CONFIG.WEATHER;

    const WX = APP.weather = {
        current: null, hourly: null, air: null, station: null,
        mode: 'auto',                                  // auto | clear | cloudy | rain | storm
        effect: { cloud: 0, rain: 0, storm: false },   // what the scene shows
        refresh
    };

    // WMO weather interpretation codes
    const WMO = {
        0: ['☀️', 'Clear sky'], 1: ['🌤️', 'Mainly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
        45: ['🌫️', 'Fog'], 48: ['🌫️', 'Rime fog'],
        51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Dense drizzle'],
        56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
        61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
        66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
        71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
        80: ['🌦️', 'Light showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Violent showers'],
        85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'],
        95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Thunderstorm, heavy hail']
    };
    const wmo = (code, isDay) => {
        const w = WMO[code] || ['❔', 'Unknown'];
        if (!isDay && code <= 1) return ['🌙', code ? 'Mainly clear' : 'Clear night'];
        return w;
    };
    const isRainCode = c => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;

    const AQI = [[50, 'Good', '#22c55e'], [100, 'Moderate', '#eab308'], [150, 'Unhealthy for sensitive groups', '#f97316'],
        [200, 'Unhealthy', '#ef4444'], [300, 'Very unhealthy', '#a855f7'], [Infinity, 'Hazardous', '#7f1d1d']];
    const aqiCat = v => AQI.find(a => v <= a[0]);

    function setStatus(t, cls) { const s = $('wx-status'); s.textContent = t; s.className = 'status ' + (cls || ''); }

    // ---------- fetching ----------
    async function getJSON(url) {
        const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    }
    async function refresh() {
        const { lat, lon } = CONFIG.GEOREF;
        setStatus('Updating…');
        const fURL = `${W.forecastURL}?latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
            `&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day&forecast_hours=12` +
            `&wind_speed_unit=ms&timezone=auto`;
        const aURL = `${W.airURL}?latitude=${lat}&longitude=${lon}` +
            `&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,uv_index&timezone=auto`;
        const [f, a, s] = await Promise.allSettled([
            getJSON(fURL), getJSON(aURL),
            W.waqiToken ? getJSON(`https://api.waqi.info/feed/geo:${lat};${lon}/?token=${W.waqiToken}`) : Promise.resolve(null)
        ]);
        if (f.status === 'fulfilled') {
            WX.current = f.value.current; WX.hourly = f.value.hourly;
            document.dispatchEvent(new CustomEvent('weather-data', { detail: WX.current }));
        }
        if (a.status === 'fulfilled') WX.air = a.value.current;
        if (s.status === 'fulfilled' && s.value && s.value.status === 'ok') WX.station = s.value.data;
        const ok = f.status === 'fulfilled';
        setStatus(ok ? `Live · Open-Meteo · ${WX.current.time.replace('T', ' ')} WIB` : 'Weather unavailable (offline?) — retrying in 15 min', ok ? 'ok' : 'warn');
        computeEffect(); render();
    }

    // ---------- scene effect ----------
    function computeEffect() {
        const e = WX.effect, c = WX.current;
        if (WX.mode === 'clear') Object.assign(e, { cloud: 0.05, rain: 0, storm: false });
        else if (WX.mode === 'cloudy') Object.assign(e, { cloud: 0.85, rain: 0, storm: false });
        else if (WX.mode === 'rain') Object.assign(e, { cloud: 0.95, rain: 0.6, storm: false });
        else if (WX.mode === 'storm') Object.assign(e, { cloud: 1, rain: 1, storm: true });
        else if (c) {
            const mm = (c.precipitation || 0);
            const raining = mm > 0.05 || isRainCode(c.weather_code);
            Object.assign(e, {
                cloud: Math.max(c.cloud_cover / 100, raining ? 0.8 : 0),
                rain: raining ? Math.min(1, Math.max(0.2, mm / 6)) : 0,
                storm: c.weather_code >= 95
            });
        } else Object.assign(e, { cloud: 0, rain: 0, storm: false });
        document.dispatchEvent(new CustomEvent('weather-effect', { detail: e }));
    }

    // ---------- rendering ----------
    const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    function render() {
        const c = WX.current, a = WX.air;
        if (c) {
            const [ico, txt] = wmo(c.weather_code, c.is_day);
            $('wx-now').innerHTML = `
                <div class="wx-big"><span class="wx-ico">${ico}</span><div><b>${c.temperature_2m.toFixed(1)}°C</b><span>${txt}</span></div></div>
                <div class="kv">
                    <span>Feels like</span><b>${c.apparent_temperature.toFixed(1)}°C</b>
                    <span>Humidity</span><b>${c.relative_humidity_2m}%</b>
                    <span>Cloud cover</span><b>${c.cloud_cover}%</b>
                    <span>Precipitation</span><b>${c.precipitation.toFixed(1)} mm/h</b>
                    <span>Pressure</span><b>${Math.round(c.pressure_msl)} hPa</b>
                    <span>Wind</span><b>${c.wind_speed_10m.toFixed(1)} m/s · ${Math.round(c.wind_direction_10m)}°</b>
                </div>`;
            const h = WX.hourly;
            if (h) {
                $('wx-hours').innerHTML = h.time.slice(0, 12).filter((_, i) => i % 2 === 0).map((t, j) => {
                    const i = j * 2, [ic] = wmo(h.weather_code[i], h.is_day[i]);
                    return `<div><span>${t.slice(11, 16)}</span><i>${ic}</i><b>${Math.round(h.temperature_2m[i])}°</b><em>${h.precipitation_probability[i] ?? 0}%</em></div>`;
                }).join('');
            }
        }
        if (a) {
            const cat = aqiCat(a.us_aqi);
            $('aq-now').innerHTML = `
                <div class="aq-big" style="--c:${cat[2]}"><b>${Math.round(a.us_aqi)}</b><div><span>US AQI</span><em>${cat[1]}</em></div></div>
                <div class="kv">
                    <span>PM2.5</span><b>${a.pm2_5.toFixed(1)} µg/m³</b>
                    <span>PM10</span><b>${a.pm10.toFixed(1)} µg/m³</b>
                    <span>Ozone (O₃)</span><b>${Math.round(a.ozone)} µg/m³</b>
                    <span>NO₂</span><b>${a.nitrogen_dioxide.toFixed(1)} µg/m³</b>
                    <span>SO₂</span><b>${a.sulphur_dioxide.toFixed(1)} µg/m³</b>
                    <span>CO</span><b>${Math.round(a.carbon_monoxide)} µg/m³</b>
                    ${a.uv_index != null ? `<span>UV index</span><b>${a.uv_index.toFixed(1)}</b>` : ''}
                </div>
                <div class="subtle">Model estimate (CAMS via Open-Meteo, ~25–40 km grid), ${a.time.replace('T', ' ')} WIB.</div>`;
        }
        const st = WX.station;
        $('aq-station').innerHTML = st ? `Nearest station: <b>${esc(st.city.name)}</b> — AQI <b>${esc(st.aqi)}</b> (${esc(st.time.s)}) · <a href="${esc(st.city.url)}" target="_blank" rel="noopener">WAQI</a>` : '';

        // floating chip
        const chip = $('wx-chip');
        if (c) {
            const [ico] = wmo(c.weather_code, c.is_day);
            $('chip-wx').textContent = `${ico} ${Math.round(c.temperature_2m)}°C`;
        }
        if (a) {
            const cat = aqiCat(a.us_aqi);
            $('chip-aq').innerHTML = `<i style="background:${cat[2]}"></i>AQI ${Math.round(a.us_aqi)}`;
        }
        chip.classList.toggle('ready', !!(c || a));
    }

    // ---------- UI ----------
    $('wx-refresh').onclick = refresh;
    $('wx-mode').onchange = e => { WX.mode = e.target.value; computeEffect(); };
    $('wx-chip').onclick = () => {
        const c = document.getElementById('sidebar-container');
        if (APP.mode !== 'orbit') return;
        c.classList.remove('collapsed');
        const sec = $('sec-weather'); sec.open = true;
        setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    };

    refresh();
    setInterval(refresh, W.refreshMinutes * 60000);
})();
