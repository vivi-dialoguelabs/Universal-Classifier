import { useState, useRef } from "react";
import * as XLSX from "xlsx";

const SYSTEM_PROMPT =
"You are an expert business directory classifier. Classify each title into exactly one of the 24 valid categories below.\n\n" +
"FORBIDDEN: Never output 'General Information'. If unsure, pick the closest category.\n\n" +
"VALID CATEGORIES:\n" +
"Arts & Entertainment, Automotive, Bars & Nightlife, Beauty & Personal Care, Dental Services, Education, Event Services, Financial Services, Fitness & Sports, Health & Medical, Home Services, Insurance, Legal Services, Local Services, Pets, Professional Services, Public Services & Government, Real Estate, Religious Organizations, Restaurants & Food, Senior Living & Care, Shopping & Retail, Travel & Lodging, Weather & Climate\n\n" +
"KEY RULES:\n" +
"- X shop/store where X=product → Shopping & Retail\n" +
"- Radio/TV call letters or frequencies → Public Services & Government\n" +
"- Obituaries/funeral homes → Public Services & Government\n" +
"- Apartments/rent/housing → Real Estate\n" +
"- How far is X / distance → Travel & Lodging\n" +
"- Named restaurants/cafes → Restaurants & Food\n" +
"- Attorneys/law firms → Legal Services\n" +
"- Windshield replacement → Automotive\n" +
"- Sauna/wellness → Health & Medical\n" +
"- Job listings/staffing → Professional Services\n" +
"- AA/NA/recycling/trash → Public Services & Government\n" +
"- Cooking classes/summer camps → Education\n" +
"- City name or city facts → Public Services & Government\n" +
"- Personal name alone → Local Services\n" +
"- Sports teams, games, scores, schedules, players, stadiums → Fitness & Sports\n" +
"- 'What channel does [sports team] game come on' → Arts & Entertainment (finding where to watch)\n" +
"- Questions about animals/birds/wildlife (e.g. Baltimore Orioles the bird) → Arts & Entertainment\n" +
"- 'What channel is X' or 'What channel does X come on' → Arts & Entertainment (user is looking for a show, game, or program to watch)\n" +
"- TV channel questions about sports games or entertainment programs → Arts & Entertainment\n" +
"- TV channel questions about news stations (NBC News, CNN, local news) → Arts & Entertainment\n" +
"- Radio/TV call letters or frequencies as a station identifier (WRCB, 96.5 FM) → Public Services & Government\n\n" +
"OUTPUT: Return ONLY a valid JSON array of strings, one per title, same order as input. No markdown, no explanation.\n" +
"Example: [\"Automotive\",\"Restaurants & Food\",\"Real Estate\"]";

const VALID_CATS = [
  "Arts & Entertainment","Automotive","Bars & Nightlife","Beauty & Personal Care",
  "Dental Services","Education","Event Services","Financial Services","Fitness & Sports",
  "Health & Medical","Home Services","Insurance","Legal Services","Local Services",
  "Pets","Professional Services","Public Services & Government","Real Estate",
  "Religious Organizations","Restaurants & Food","Senior Living & Care",
  "Shopping & Retail","Travel & Lodging","Weather & Climate"
];

const CAT_COLORS = {
  "Arts & Entertainment":"#8b5cf6","Automotive":"#6366f1","Bars & Nightlife":"#ec4899",
  "Beauty & Personal Care":"#f472b6","Dental Services":"#06b6d4","Education":"#3b82f6",
  "Event Services":"#a78bfa","Financial Services":"#10b981","Fitness & Sports":"#f59e0b",
  "Health & Medical":"#ef4444","Home Services":"#84cc16","Insurance":"#14b8a6",
  "Legal Services":"#7c3aed","Local Services":"#f97316","Pets":"#fb923c",
  "Professional Services":"#0ea5e9","Public Services & Government":"#64748b",
  "Real Estate":"#22c55e","Religious Organizations":"#a855f7","Restaurants & Food":"#f43f5e",
  "Senior Living & Care":"#0891b2","Shopping & Retail":"#e11d48",
  "Travel & Lodging":"#0284c7","Weather & Climate":"#38bdf8"
};

async function callAPI(titles) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: "Classify these " + titles.length + " titles. Return a JSON array of exactly " +
          titles.length + " strings:\n" + titles.map((t,i) => (i+1)+". "+t).join("\n")
      }]
    })
  });

  const data = await response.json();
  if (data.error) {
    if (data.error.type === "exceeded_limit" || data.error.type === "rate_limit_error") throw new Error("RATE_LIMIT");
    throw new Error(data.error.message || data.error.type);
  }
  const text = (data.content || []).map(c => c.text || "").join("").trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON array in response");
  const arr = JSON.parse(match[0]);
  if (!Array.isArray(arr)) throw new Error("Response is not an array");
  return arr.map(c => VALID_CATS.includes(c) ? c : "Local Services");
}

function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const headers = raw[0].map(String);
        const rows = raw.slice(1).filter(row => row.some(c => String(c).trim()));
        res({ headers, rows });
      } catch(e) { rej(e.message); }
    };
    r.onerror = () => rej("Read failed");
    r.readAsArrayBuffer(file);
  });
}

function findTitleCol(headers) {
  const kw = ["title","headline","keyword","name","article","query","topic"];
  return headers.find(h => kw.some(k => h.toLowerCase().includes(k))) || headers[0];
}

const BATCH = 40;

export default function App() {
  const [phase, setPhase] = useState("idle"); // idle | ready | running | done | error
  const [fileData, setFileData] = useState(null);
  const [titleCol, setTitleCol] = useState("");
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState("");
  const [results, setResults] = useState([]);
  const [counts, setCounts] = useState({});
  const [errorMsg, setErrorMsg] = useState("");
  const fileRef = useRef();
  const stopRef = useRef(false);

  const onFile = async (file) => {
    if (!file) return;
    setPhase("idle"); setLog("Reading file…");
    try {
      const { headers, rows } = await readFile(file);
      const tc = findTitleCol(headers);
      setFileData({ name: file.name, baseName: file.name.replace(/\.[^.]+$/,""), headers, rows });
      setTitleCol(tc);
      setProgress(0); setResults([]); setCounts({}); setErrorMsg(""); setLog("");
      setPhase("ready");
    } catch(e) {
      setLog(""); setErrorMsg("Could not read file: " + e); setPhase("error");
    }
  };

  const run = async () => {
    if (!fileData) return;
    stopRef.current = false;
    setPhase("running"); setProgress(0); setResults([]); setCounts({}); setErrorMsg("");
    const ci = fileData.headers.indexOf(titleCol);
    const titles = fileData.rows.map(r => String(r[ci] || "").trim() || "(empty)");
    const total = titles.length;
    const all = [];
    const cnt = {};

    for (let i = 0; i < titles.length; i += BATCH) {
      if (stopRef.current) break;
      const batchNum = Math.floor(i / BATCH) + 1;
      const totalBatches = Math.ceil(titles.length / BATCH);
      const batch = titles.slice(i, i + BATCH);
      setLog("Batch " + batchNum + " of " + totalBatches + "…");
      let cats = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (stopRef.current) break;
        try {
          cats = await callAPI(batch);
          break;
        } catch(e) {
          if (e.message === "RATE_LIMIT") {
            setLog("Rate limit — waiting 60s…");
            await new Promise(r => setTimeout(r, 60000));
            attempt--;
            continue;
          }
          setLog("Batch " + batchNum + " retry " + (attempt+1) + ": " + e.message);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          else cats = batch.map(() => "Local Services");
        }
      }
      if (!cats) cats = batch.map(() => "Local Services");
      while (cats.length < batch.length) cats.push("Local Services");
      cats = cats.slice(0, batch.length);
      cats.forEach(c => { cnt[c] = (cnt[c]||0)+1; });
      all.push(...cats);
      setProgress(Math.min(i + BATCH, total));
      setCounts({...cnt});
      await new Promise(r => setTimeout(r, 100));
    }

    setResults([...all]);
    setPhase("done");
    setLog("");
  };

  const stop = () => { stopRef.current = true; setPhase("ready"); setLog("Stopped."); };

  const exportFile = () => {
    if (!fileData || !results.length) return;
    try {
      const rows = [
        [...fileData.headers, "classified_category"],
        ...fileData.rows.map((r,i) => [...fileData.headers.map((_,ci) => r[ci] ?? ""), results[i] || ""])
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Classified");
      const buf = XLSX.write(wb, { bookType:"xlsx", type:"array" });
      const url = URL.createObjectURL(new Blob([buf], { type:"application/octet-stream" }));
      const a = Object.assign(document.createElement("a"), { href:url, download: fileData.baseName+"_classified.xlsx" });
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    } catch(e) { alert("Export error: " + e.message); }
  };

  const total = fileData?.rows?.length || 0;
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const topCats = Object.entries(counts).sort((a,b) => b[1]-a[1]);

  const Btn = ({onClick, color, children, disabled}) => (
    <button onClick={onClick} disabled={disabled} style={{
      flex:1, padding:"12px", border:"none", borderRadius:10, cursor: disabled?"not-allowed":"pointer",
      fontSize:14, fontWeight:700, color:"#fff", opacity: disabled?0.5:1,
      background: color==="green" ? "linear-gradient(135deg,#059669,#0ea5e9)"
                : color==="red"   ? "linear-gradient(135deg,#dc2626,#f97316)"
                : "linear-gradient(135deg,#6366f1,#38bdf8)"
    }}>{children}</button>
  );

  return (
    <div style={{ minHeight:"100vh", background:"#0f172a", color:"#f1f5f9", fontFamily:"Inter,sans-serif", padding:"32px 20px" }}>
      <div style={{ maxWidth:620, margin:"0 auto" }}>

        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontSize:36 }}>🗂️</div>
          <h1 style={{ margin:"8px 0 4px", fontSize:22, fontWeight:700, background:"linear-gradient(135deg,#818cf8,#38bdf8)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
            Universal Article Classifier
          </h1>
          <p style={{ color:"#475569", fontSize:12, margin:0 }}>Upload XLSX · Classify every row · Export with classified_category column</p>
        </div>

        {/* Upload */}
        <div
          onClick={() => fileRef.current.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}
          style={{ border:"2px dashed #334155", borderRadius:12, padding:"28px", textAlign:"center", cursor:"pointer", background:"#1e293b", marginBottom:18 }}
          onMouseEnter={e => e.currentTarget.style.borderColor="#818cf8"}
          onMouseLeave={e => e.currentTarget.style.borderColor="#334155"}
        >
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e => onFile(e.target.files[0])} />
          {fileData ? (
            <div>
              <div style={{ fontSize:22, marginBottom:4 }}>📄</div>
              <div style={{ fontWeight:600, fontSize:14 }}>{fileData.name}</div>
              <div style={{ color:"#64748b", fontSize:12, marginTop:3 }}>{total.toLocaleString()} rows · {fileData.headers.length} columns · Click to change</div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize:28, marginBottom:6 }}>📁</div>
              <div style={{ color:"#94a3b8", fontSize:14 }}>Click or drop .xlsx / .xls file here</div>
            </div>
          )}
        </div>

        {/* Column picker */}
        {fileData && phase !== "running" && (
          <div style={{ background:"#1e293b", borderRadius:11, padding:"14px 18px", marginBottom:14 }}>
            <div style={{ color:"#64748b", fontSize:12, marginBottom:6 }}>Title Column</div>
            <select value={titleCol} onChange={e => setTitleCol(e.target.value)}
              style={{ width:"100%", background:"#0f172a", color:"#f1f5f9", border:"1px solid #334155", borderRadius:8, padding:"8px 12px", fontSize:13, outline:"none" }}>
              {fileData.headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
            <div style={{ marginTop:8, display:"flex", flexWrap:"wrap", gap:5 }}>
              {fileData.rows.slice(0,3).map((r,i) => {
                const ci = fileData.headers.indexOf(titleCol);
                return <span key={i} style={{ background:"#0f172a", border:"1px solid #334155", borderRadius:5, padding:"2px 8px", fontSize:11, color:"#94a3b8" }}>{String(r[ci]||"").slice(0,60)}</span>;
              })}
            </div>
          </div>
        )}

        {/* Buttons */}
        {fileData && (
          <div style={{ display:"flex", gap:10, marginBottom:16 }}>
            {phase !== "running" && <Btn onClick={run}>{phase==="done" ? "🔄 Re-classify" : "⚡ Classify"}</Btn>}
            {phase === "running" && <Btn color="red" onClick={stop}>⏹ Stop</Btn>}
            {phase === "done" && <Btn color="green" onClick={exportFile}>⬇️ Export Excel</Btn>}
          </div>
        )}

        {/* Progress */}
        {(phase === "running" || phase === "done") && (
          <div style={{ background:"#1e293b", borderRadius:11, padding:"14px 18px", marginBottom:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
              <span style={{ fontSize:13, fontWeight:600 }}>{phase==="done" ? "✅ Done!" : "⚙️ Classifying…"}</span>
              <span style={{ color:"#38bdf8", fontSize:13, fontWeight:700 }}>{progress.toLocaleString()} / {total.toLocaleString()} ({pct}%)</span>
            </div>
            <div style={{ background:"#0f172a", borderRadius:99, height:8, overflow:"hidden" }}>
              <div style={{ width:pct+"%", height:"100%", background:"linear-gradient(90deg,#6366f1,#38bdf8)", borderRadius:99, transition:"width 0.3s" }}/>
            </div>
            {log && <div style={{ marginTop:8, fontSize:11, color:"#64748b" }}>{log}</div>}
          </div>
        )}

        {/* Error */}
        {errorMsg && (
          <div style={{ background:"#1e0a0a", border:"1px solid #7f1d1d", borderRadius:10, padding:"12px 16px", color:"#ef4444", fontSize:13, marginBottom:14 }}>{errorMsg}</div>
        )}

        {/* Breakdown */}
        {topCats.length > 0 && (
          <div style={{ background:"#1e293b", borderRadius:11, padding:"14px 18px" }}>
            <div style={{ fontWeight:600, fontSize:13, marginBottom:10 }}>📊 Category Breakdown</div>
            {topCats.map(([cat, cnt]) => (
              <div key={cat} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:5 }}>
                <div style={{ width:170, fontSize:11, color:"#cbd5e1", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", flexShrink:0 }}>{cat}</div>
                <div style={{ flex:1, background:"#0f172a", borderRadius:99, height:5 }}>
                  <div style={{ width:Math.round((cnt/total)*100)+"%", height:"100%", background: CAT_COLORS[cat]||"#6366f1", borderRadius:99 }}/>
                </div>
                <div style={{ fontSize:11, color:"#94a3b8", width:40, textAlign:"right" }}>{cnt.toLocaleString()}</div>
                <div style={{ fontSize:10, color:"#475569", width:30, textAlign:"right" }}>{Math.round((cnt/total)*100)}%</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
