import { useLayoutEffect, useRef, useState } from "react";
import SectionFrame from "../../components/SectionFrame";
import { useInView, useCountUp } from "../../lib/hooks";
import "./DarkWalletEleven.css";

const I = {
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 16V10a6 6 0 1 0-12 0v6l-1.6 2.2h15.2L18 16Z" /><path d="M10 20.4a2.2 2.2 0 0 0 4 0" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  up: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>,
  right: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M12 5l7 7-7 7" /></svg>,
  dots: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5.5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="18.5" r="1.7" /></svg>,
  refresh: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4.6h-4.6" /></svg>,
  chev: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m7 10 5 5 5-5" /></svg>,
};

const TABS = ["Dashboard", "Statistics", "Transactions", "My wallet"];

function Nav() {
  const [active, setActive] = useState(0);
  const [box, setBox] = useState(null);
  const wrap = useRef(null), refs = useRef([]);
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[active], host = wrap.current;
      if (!el || !host) return;
      const a = el.getBoundingClientRect(), b = host.getBoundingClientRect();
      // SectionFrame scales the whole canvas, so rects come back in visual px
      // while the marker is positioned in layout px — divide the scale back out
      const scale = b.width / (host.offsetWidth || b.width || 1);
      const n = { left: (a.left - b.left) / scale, width: a.width / scale };
      // the equality guard is load-bearing: without it every measure sets a new
      // object and the observer below re-renders forever
      setBox((p) => (p && Math.abs(p.left - n.left) < .5 && Math.abs(p.width - n.width) < .5 ? p : n));
    };
    measure();
    // webfonts land after first paint and change the tab widths, and the tab
    // that is active at mount never re-runs this effect on its own
    document.fonts?.ready.then(measure);
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [active]);
  return (
    <div className="d11__nav" ref={wrap}>
      {box && <span className="d11__navMark" style={{ transform: `translateX(${box.left}px)`, width: box.width }} />}
      {TABS.map((t, i) => (
        <button key={t} ref={(el) => (refs.current[i] = el)} data-active={i === active} onClick={() => setActive(i)}>{t}</button>
      ))}
    </div>
  );
}

/* ---------- revenue bars ---------- */
const REV = [{ m: "Apr", v: 42, d: "+$4.1K" }, { m: "May", v: 30, d: "+$2.2K" }, { m: "Jun", v: 54, d: "+$3.5K" }, { m: "Jul", v: 22, d: "+$1.2K" }, { m: "Aug", v: 88, d: "+$2.4K" }];

function Rev() {
  const [ref, inView] = useInView();
  const [hov, setHov] = useState(null);
  const active = hov ?? 4;
  return (
    <div className="d11-rev" ref={ref} onMouseLeave={() => setHov(null)}>
      <div className="d11-rev__plot">
        {REV.map((r, i) => (
          <button key={r.m} className="d11-rev__col" data-active={i === active} onMouseEnter={() => setHov(i)} aria-label={r.m}>
            <span className="d11-rev__tip" data-show={i === active} style={{ "--h": `${r.v}%` }}>
              <i>{I.up}</i>$2,456.00<em>+16%</em>
            </span>
            <span className="d11-rev__bar" data-in={inView} style={{ "--h": `${r.v}%`, "--i": i }}>
              {i === active && <u />}
            </span>
          </button>
        ))}
      </div>
      <div className="d11-rev__axis">{REV.map((r) => <span key={r.m}>{r.d}<i>{r.m}</i></span>)}</div>
    </div>
  );
}

/* ---------- expense donut ---------- */
const SLICES = [
  { l: "Food", v: 30, c: "#f2c94c" }, { l: "Entertainment", v: 10, c: "#8b5cf6" },
  { l: "Health", v: 10, c: "#38bdf8" }, { l: "Transport", v: 15, c: "#f97316" },
  { l: "Bills", v: 20, c: "#22c55e" }, { l: "Misc", v: 15, c: "#ec4899" },
];

function Donut({ size = 190 }) {
  const [ref, inView] = useInView();
  const n = useCountUp(1124, { run: inView, duration: 1200 });
  const c = size / 2, r = c - 17, circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="d11-donut" ref={ref} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`}>
        {SLICES.map((s, i) => {
          const len = (s.v / 100) * circ;
          const off = acc; acc += len;
          return (
            <circle key={s.l} className="d11-donut__s" data-in={inView}
              cx={c} cy={c} r={r} stroke={s.c} strokeWidth="18" strokeLinecap="butt"
              strokeDasharray={`${len - 3} ${circ}`} strokeDashoffset={inView ? -off : -circ}
              transform={`rotate(-90 ${c} ${c})`} style={{ "--i": i }} />
          );
        })}
      </svg>
      <span><i>Total</i><b className="ui-num">{Math.round(n).toLocaleString("en-US")}<em>$</em></b></span>
    </div>
  );
}

const SUBS = [
  { n: "Cloud drive", p: "2.99", d: "Next 15 July", i: 0 },
  { n: "Chat pro", p: "8.99", d: "Next 19 July", i: 1 },
  { n: "Messenger", p: "4.99", d: "Next 04 August", i: 2 },
  { n: "Design library", p: "12.00", d: "Next 09 August", i: 3 },
];

const RECENT = [
  { n: "Messenger", d: "04.07.2026 · 12:40 AM", s: "Successful", card: "4352", a: "−$4.99", i: 2 },
  { n: "Design library", d: "02.07.2026 · 09:12 AM", s: "Successful", card: "6902", a: "−$12.00", i: 3 },
];

function Fig({ v, dp = 2, suffix = "$" }) {
  const [ref, inView] = useInView({ threshold: .4 });
  const n = useCountUp(v, { run: inView, duration: 1250 });
  return <b className="ui-num" ref={ref}>{n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}<em>{suffix}</em></b>;
}

/* ================= section ================= */
export default function DarkWalletEleven() {
  return (
    <SectionFrame id="darkwallet-eleven" background="#c8c2d6">
      <div className="d11">
        <header className="d11__top">
          <span className="d11__brand"><i>Ξ</i>zemli</span>
          <Nav />
          <span className="d11__topRight">
            <button className="d11__ico" aria-label="Search">{I.search}</button>
            <button className="d11__ico" aria-label="Alerts">{I.bell}</button>
            <span className="d11__me">AK</span>
          </span>
        </header>

        <h1 className="d11__title">My dashboard</h1>

        {/* balance */}
        <section className="d11__bal">
          <span className="ui-label">Total balance</span>
          <p className="d11__balFig"><Fig v={120456.5} /></p>
          <i>+$2,456 revenue from last month</i>
          <div className="d11__balBtns">
            <button data-v="ink">Transfer</button>
            <button data-v="light">Top up <i>◎</i></button>
          </div>
          <span className="d11__balSheen" aria-hidden="true" />
        </section>

        {/* income / expense */}
        <section className="d11__card d11__inc">
          <span className="ui-label">Income</span>
          <p><Fig v={2456} dp={0} /><span className="ui-pill" data-tone="up">+15.7%</span></p>
          <i>This week</i>
        </section>

        <section className="d11__card d11__exp">
          <span className="ui-label">Expense</span>
          <p><b className="ui-num">−1,124<em>$</em></b><span className="ui-pill" data-tone="down">−10.7%</span></p>
          <i>This week</i>
        </section>

        {/* cards */}
        <section className="d11__card d11__cards">
          <header><h3>My cards <sup>3</sup></h3><button className="d11__add">Add {I.plus}</button></header>
          <div className="d11__stack">
            <span className="d11__stackC" data-i="0"><i className="ui-num">•••• 3268</i></span>
            <span className="d11__stackC" data-i="1"><i className="ui-num">•••• 4352</i></span>
            <span className="d11__stackC" data-i="2"><i className="ui-num">•••• 6902</i></span>
          </div>
          <div className="d11__cardActive">
            <p className="ui-num">4156 6727 1439 6902</p>
            <footer><span>Micky Larson</span><span className="ui-num">07/25</span></footer>
          </div>
        </section>

        {/* revenue */}
        <section className="d11__card d11__rev">
          <header><h3>Revenue flow</h3><span className="d11__tools"><button className="d11__chip">Monthly {I.chev}</button><button className="d11__ico d11__ico--sm" aria-label="Open">{I.up}</button></span></header>
          <Rev />
        </section>

        {/* expense split */}
        <section className="d11__card d11__split">
          <header><h3>Expense split</h3><button className="d11__chip">Aug {I.chev}</button></header>
          <div className="d11__splitBody">
            <Donut />
            <ul className="d11__legend">
              {SLICES.map((s) => (
                <li key={s.l}><i style={{ background: s.c }} />{s.l}<b>{s.v}%</b></li>
              ))}
            </ul>
          </div>
        </section>

        {/* subscriptions */}
        <section className="d11__card d11__subs">
          <header><h3>Subscriptions <sup>5</sup></h3><button className="d11__manage">Manage {I.right}</button></header>
          <div className="d11__subIcons">
            {["#5865f2", "#3c3c46", "#2fbf6d", "#e05a8a", "#229ed9"].map((c, i) => (
              <span key={c} style={{ background: c, "--i": i }} />
            ))}
          </div>
          <ul>
            {SUBS.map((s) => (
              <li key={s.n}>
                <span className="d11__subM" data-i={s.i} />
                <span className="d11__subT"><b>{s.n}</b><i>{s.d}</i></span>
                <span className="ui-num">${s.p}</span>
                <button className="d11__ico d11__ico--sm" aria-label="Options">{I.dots}</button>
              </li>
            ))}
          </ul>
        </section>

        {/* recent */}
        <section className="d11__card d11__recent">
          <header><h3>Recent transactions <sup>234</sup></h3><button className="d11__manage">See all {I.right}</button></header>
          {RECENT.map((r) => (
            <div className="d11__recentRow" key={r.n}>
              <span className="d11__subM" data-i={r.i} />
              <span className="d11__subT"><b>{r.n}</b><i>{r.d}</i></span>
              <span className="ui-pill d11__recentSt" data-tone="up">{r.s}</span>
              <span className="ui-num d11__recentCard">••{r.card}</span>
              <span className="ui-num d11__recentAmt">{r.a}</span>
              <button className="d11__ico d11__ico--sm" aria-label="Options">{I.dots}</button>
            </div>
          ))}
        </section>
      </div>
    </SectionFrame>
  );
}
