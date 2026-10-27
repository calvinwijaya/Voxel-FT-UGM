// =====================================================================
//  TOUCH — on-screen controls for first/third person on phones & tablets
//  Left thumb: joystick (push to the edge = run). Right side: drag to look.
//  Buttons re-use the keyboard shortcuts so behaviour is identical.
// =====================================================================
(function () {
    if (!APP.isTouch) return;
    const $ = id => document.getElementById(id);
    const P = APP.player;

    // ---------- joystick ----------
    const joy = $('joy'), knob = $('joy-knob');
    let jid = null, cx = 0, cy = 0;
    const R = 50;
    function move(e) {
        let dx = e.clientX - cx, dy = e.clientY - cy;
        const len = Math.hypot(dx, dy);
        if (len > R) { dx *= R / len; dy *= R / len; }
        knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        P.analog.x = dx / R; P.analog.y = dy / R;
    }
    function release() {
        jid = null; P.analog.x = P.analog.y = 0;
        knob.style.transform = 'translate(-50%, -50%)';
    }
    joy.addEventListener('pointerdown', e => {
        if (jid !== null) return;
        jid = e.pointerId; joy.setPointerCapture(jid);
        const r = joy.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
        move(e); e.preventDefault();
    });
    joy.addEventListener('pointermove', e => { if (e.pointerId === jid) move(e); });
    joy.addEventListener('pointerup', e => { if (e.pointerId === jid) release(); });
    joy.addEventListener('pointercancel', e => { if (e.pointerId === jid) release(); });

    // ---------- buttons → synthetic key events ----------
    const key = (type, code) => dispatchEvent(new KeyboardEvent(type, { code }));
    document.querySelectorAll('#touch-btns [data-key]').forEach(b => {
        const code = b.dataset.key, hold = b.hasAttribute('data-hold');
        b.addEventListener('pointerdown', e => {
            e.preventDefault(); b.classList.add('down');
            key('keydown', code);
            if (!hold) key('keyup', code);
        });
        const up = () => { b.classList.remove('down'); if (hold) key('keyup', code); };
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        b.addEventListener('pointerleave', up);
    });
    $('touch-exit').addEventListener('click', () => { release(); APP.enterMode('orbit'); });

    // ---------- pinch to zoom the third-person camera ----------
    const pts = new Map(); let pinch0 = 0, dist0 = 6;
    const cv = APP.renderer.domElement;
    cv.addEventListener('pointerdown', e => {
        pts.set(e.pointerId, e);
        if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); dist0 = P.tpDist; }
    });
    cv.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
        if (pts.size === 2 && APP.mode === 'tp' && pinch0) {
            const [a, b] = [...pts.values()], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
            P.tpDist = Math.max(2, Math.min(30, dist0 * pinch0 / d));
        }
    });
    const drop = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; };
    cv.addEventListener('pointerup', drop);
    cv.addEventListener('pointercancel', drop);

    // stop the browser from scrolling / zooming the page while playing
    ['touchmove', 'gesturestart'].forEach(ev => document.addEventListener(ev, e => {
        if (APP.mode !== 'orbit' && !e.target.closest('#sidebar')) e.preventDefault();
    }, { passive: false }));
})();
