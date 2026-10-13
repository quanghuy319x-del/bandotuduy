/* Branchline v678 — read-only Recovery History + guarded selective restore.
   Loaded after the journal and before Drive sync. Functions run after boot. */
"use strict";

(function initRecoveryHistory() {
  const modal = document.getElementById("recovery-history-modal");
  const openBtn = document.getElementById("btn-recovery-history");
  if (!modal || !openBtn) return;
  const $r = (id) => document.getElementById(id);
  const revisionList = $r("recovery-revisions");
  const itemList = $r("recovery-items");
  const preview = $r("recovery-preview");
  const info = $r("recovery-info");
  const search = $r("recovery-search");
  const restoreOneBtn = $r("recovery-restore-one");
  const restoreAllBtn = $r("recovery-restore-all");
  const filter = $r("recovery-filter");
  let mapId = null, rows = [], active = null, selected = null, candidates = [];
  let working = false;

  const clone = (x) => editClone(x);
  const same = (a,b) => editValueEqual(a,b);
  const dateTime = (ts) => new Date(Number(ts) || Date.now()).toLocaleString();
  const arr = (x) => Array.isArray(x) ? x : [];
  function walkNodes(root, cb) {
    (function walk(node) {
      if (!node) return;
      cb(node);
      arr(node.children).forEach(walk);
    })(root);
  }
  function findNodeIn(root, id) {
    let found = null;
    walkNodes(root, n => { if (String(n.id) === String(id)) found = n; });
    return found;
  }
  function calendarISO(table, r, c) {
    if (!table || !table.calendar || r < 2) return "";
    const year = Number(table.calendarYear), month = Number(table.calendarMonth);
    if (!(year >= 1900 && month >= 1 && month <= 12)) return "";
    const start = Number.isFinite(Number(table.calendarStart))
      ? Number(table.calendarStart) : (new Date(year, month-1, 1).getDay()+6)%7;
    const d = new Date(year, month-1, 1 + (r-2)*7+c-start);
    if (d.getFullYear() !== year || d.getMonth()+1 !== month) return "";
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }
  function collectItems(map) {
    const out = new Map();
    if (!map || !map.root) return out;
    function add(kind, key, label, value, ref, location) {
      if (value === undefined || value === null) return;
      out.set(key, { kind, key, label, value, ref, location: location || "" });
    }
    function notes(host, ref, where) {
      arr(host && host.notes).forEach((n,i) => {
        if (!n || !n.id) return;
        add("note","note:"+n.id,(n.title || "Untitled note"),n,
          { ...ref, noteId:n.id, index:i },where);
      });
    }
    function tasks(host, ref, where) {
      arr(host && host.tasks).forEach((t,i) => {
        if (!t || !t.id) return;
        const taskRef = { ...ref, taskId:t.id, index:i };
        add("task","task:"+t.id,t.text || "Untitled task",t,taskRef,where);
        notes(t,{ ...ref, taskId:t.id },where+" → "+(t.text||"Task"));
        arr(t.subtasks).forEach((sub,j) => {
          if (!sub || !sub.id) return;
          add("subtask","subtask:"+sub.id,sub.text || "Untitled subtask",sub,
            { ...ref, taskId:t.id, subtaskId:sub.id, index:j },where+" → "+(t.text||"Task"));
          notes(sub,{ ...ref, taskId:t.id, subtaskId:sub.id },where+" → "+(t.text||"Task")+" → "+(sub.text||"Subtask"));
        });
      });
    }
    walkNodes(map.root,node => {
      const nodeRef={nodeId:node.id};
      const where=node.text || "Untitled node";
      notes(node,nodeRef,where);
      tasks(node,nodeRef,where);
      const table=node.table;
      if (!table || !Array.isArray(table.attach)) return;
      table.attach.forEach((row,r) => arr(row).forEach((host,c) => {
        if (!host) return;
        const iso=calendarISO(table,r,c);
        const cellRef={nodeId:node.id,r,c};
        const cellWhere=where+" / "+(iso || ("cell "+(r+1)+":"+(c+1)));
        notes(host,cellRef,cellWhere);
        tasks(host,cellRef,cellWhere);
        if (iso) {
          const text=table.cells && table.cells[r] ? table.cells[r][c] : "";
          add("calendar","calendar-cell:"+node.id+":"+iso,iso,
            {host,text},cellRef,where+" / "+iso);
        }
      }));
    });
    const retained=map.calendarRetained || {};
    Object.keys(retained).forEach(iso => Object.keys(retained[iso]||{}).forEach(sourceKey => {
      const value=retained[iso][sourceKey];
      if (value && value.host) add("calendar","retained:"+iso+":"+sourceKey,iso,
        value,{date:iso,sourceKey,retained:true},"Calendar history / "+iso);
    }));
    const datePhotos=map.root.calendarDatePhotos || {};
    Object.keys(datePhotos).forEach(iso => add("calendar","date-photo:"+iso,iso,
      datePhotos[iso],{date:iso,datePhotos:true},"Calendar photos / "+iso));
    return out;
  }

  // Rich HTML is previewed as text, never injected into this window.
  function describe(value) {
    if (value == null) return "(not present)";
    if (typeof value !== "object") return String(value).slice(0,350);
    const detail = [];
    if (value.text != null) detail.push("Text: "+String(value.text));
    if (value.title) detail.push("Title: "+value.title);
    if (value.html != null) {
      const el=document.createElement("div");el.innerHTML=String(value.html);
      const text=(el.textContent||"").replace(/\s+/g," ").trim();
      detail.push("Body: "+(text||"(empty)")+(el.querySelector("img,video,svg")?" [media]":""));
    }
    if (value.done != null) detail.push("Done: "+!!value.done);
    if (value.progress != null) detail.push("Progress: "+value.progress);
    if (Array.isArray(value.subtasks)) detail.push("Subtasks: "+value.subtasks.length);
    if (Array.isArray(value.notes)) detail.push("Notes: "+value.notes.length);
    if (Array.isArray(value.tasks)) detail.push("Tasks: "+value.tasks.length);
    if (value.host) {
      detail.push("Cell content: "+describe(value.host));
      if(value.text != null)detail.push("Cell text: "+value.text);
    }
    if (!detail.length) detail.push(JSON.stringify(value));
    return detail.join("\n").slice(0,1400);
  }
  function changedFields(oldValue,newValue) {
    if (oldValue == null || newValue == null) return [];
    if (typeof oldValue!=="object" || typeof newValue!=="object") return ["value"];
    return [...new Set(Object.keys(oldValue).concat(Object.keys(newValue)))]
      .filter(k => !same(oldValue[k],newValue[k])).slice(0,12);
  }
  function button(label, cb, cls) {
    const el=document.createElement("button");el.type="button";
    el.className=cls||"recovery-list-btn";el.textContent=label;
    el.addEventListener("click",cb);return el;
  }
  function putText(el,text) {el.textContent=String(text||"");}
  function getRevision() {return active && active.map ? active.map : null;}
  function currentMap() {return state.maps.find(m => m.id===mapId) || null;}
  function updatePreview() {
    const revision=getRevision(), current=currentMap();
    restoreAllBtn.disabled=working || !revision || !current || same(editSnapshotString(revision),editSnapshotString(current));
    restoreOneBtn.disabled=working || !selected || !current || !selected.restorable || selected.status==="Same";
    if (!revision || !current) {putText(preview,"Select a saved revision.");return;}
    if (!selected) {putText(preview,"Choose a changed task, subtask, note or Calendar entry on the left. Nothing is restored until you confirm.");return;}
    const fieldList=changedFields(selected.old&&selected.old.value,selected.now&&selected.now.value);
    const txt=selected.kind.toUpperCase()+" — "+selected.label+"\n"+selected.location+
      "\nStatus: "+selected.status+
      (fieldList.length?"\nChanged fields: "+fieldList.join(", "):"")+
      "\n\nSAVED REVISION\n"+describe(selected.old&&selected.old.value)+
      "\n\nCURRENT MAP\n"+describe(selected.now&&selected.now.value)+
      (selected.restorable?"":"\n\nCannot restore individually: original destination no longer exists. Use full-map restore instead.");
    putText(preview,txt);
  }
  function validTarget(item, map) {
    if (!item) return false;
    const ref=item.ref||{};
    if (ref.retained || ref.datePhotos) return true;
    const node=findNodeIn(map.root,ref.nodeId);
    if (!node) return false;
    if (ref.r != null && (!node.table || !arr(node.table.cells)[ref.r] ||
        ref.c >= arr(node.table.cells[ref.r]).length))return false;
    const host=ref.r == null ? node : arr(node.table.attach && node.table.attach[ref.r])[ref.c] || {};
    const task=ref.taskId ? arr(host.tasks).find(t=>String(t.id)===String(ref.taskId)) : null;
    if (item.kind==="subtask") return !!task;
    if (item.kind==="note" && ref.subtaskId) return !!(task && arr(task.subtasks).some(s=>String(s.id)===String(ref.subtaskId)));
    if (item.kind==="note" && ref.taskId) return !!task;
    return true;
  }
  function refreshCandidates() {
    const saved=collectItems(getRevision()), now=collectItems(currentMap());
    candidates=[];
    saved.forEach((old,key)=>{
      const current=now.get(key), status=!current?"Missing":same(old.value,current.value)?"Same":"Changed";
      if(status==="Same")return;
      const target=current||old;
      candidates.push({key,kind:old.kind,label:old.label,location:old.location,status,
        old,now:current,restorable:validTarget(target,currentMap()) || (!current && validTarget(old,currentMap()))});
    });
    // Show additions made after this revision as read-only differences.
    now.forEach((current,key)=>{
      if(saved.has(key))return;
      candidates.push({key,kind:current.kind,label:current.label,location:current.location,
        status:"Newer only",old:null,now:current,restorable:false});
    });
    candidates.sort((a,b)=>a.status.localeCompare(b.status)||a.kind.localeCompare(b.kind)||a.label.localeCompare(b.label));
    if(selected)selected=candidates.find(x=>x.key===selected.key)||null;
    renderItems();
  }
  function renderItems() {
    itemList.replaceChildren();
    const query=(search.value||"").trim().toLowerCase(), category=filter.value;
    const visible=candidates.filter(x=>(category==="all"||x.kind===category)&&
      (!query||(x.label+" "+x.location+" "+x.kind).toLowerCase().includes(query)));
    if(!visible.length){putText(itemList,"No matching differences in this revision.");}
    visible.slice(0,250).forEach(x=>{
      const el=button((x.status==="Missing"?"＋ ":"↔ ")+x.kind+" · "+x.label,()=>{
        selected=x;renderItems();updatePreview();
      },"recovery-list-btn"+(selected&&selected.key===x.key?" active":""));
      el.title=x.location+" — "+x.status;
      const meta=document.createElement("small");meta.textContent=x.status+" · "+x.location;
      el.appendChild(meta);itemList.appendChild(el);
    });
    putText(info,visible.length+" differences"+(visible.length>250?" (showing first 250)":"")+" · "+rows.length+" saved revisions on this device");
    updatePreview();
  }
  function renderRevisions() {
    revisionList.replaceChildren();
    rows.forEach((rec,i)=>{
      const label=dateTime(rec.ts)+" · "+new Date(rec.updatedAt||rec.ts).toLocaleTimeString();
      const el=button(label,()=>{active=rec;selected=null;renderRevisions();refreshCandidates();},
        "recovery-list-btn"+(active&&rec.id===active.id?" active":""));
      const sub=document.createElement("small");sub.textContent="#"+(rows.length-i)+" · "+((rec.map&&rec.map.title)||"Map");
      el.appendChild(sub);revisionList.appendChild(el);
    });
    if(!rows.length)putText(revisionList,"No recovery revisions yet. Edits saved on v677 or later will appear here.");
  }
  async function openWindow() {
    if(!state.current)return showToast("Open a map first.");
    try { commitEditIfActive(); } catch(e) {}
    mapId=state.current.id;active=null;selected=null;
    search.value="";filter.value="all";
    modal.classList.remove("hidden");
    putText(info,"Loading local recovery revisions…");
    try{
      rows=await journalRecoveryRevisions(mapId);
      active=rows.find(x=>x.map&&!same(editSnapshotString(x.map),editSnapshotString(currentMap())))||rows[0]||null;
      renderRevisions();refreshCandidates();
    }catch(e){rows=[];putText(info,"Could not read recovery journal: "+(e.message||e));renderRevisions();}
  }
  function closeWindow() {
    if(working)return;
    modal.classList.add("hidden");selected=null;active=null;rows=[];
  }
  function locateContainer(map, item) {
    const ref=item.ref||{};
    const node=findNodeIn(map.root,ref.nodeId);
    if(!node)return null;
    let host=node;
    if(ref.r!=null){
      const table=node.table;
      if(!table||!arr(table.cells)[ref.r]||ref.c>=arr(table.cells[ref.r]).length)return null;
      if(!Array.isArray(table.attach))table.attach=[];
      if(!Array.isArray(table.attach[ref.r]))table.attach[ref.r]=[];
      if(!table.attach[ref.r][ref.c])table.attach[ref.r][ref.c]={};
      host=table.attach[ref.r][ref.c];
    }
    if(item.kind==="calendar")return {node,host};
    if(item.kind==="task")return {list:host.tasks||(host.tasks=[]),host};
    if(item.kind==="subtask"||item.kind==="note"){
      const task=ref.taskId?arr(host.tasks).find(t=>String(t.id)===String(ref.taskId)):null;
      if(ref.taskId&&!task)return null;
      if(item.kind==="subtask")return task?{list:task.subtasks||(task.subtasks=[]),host:task}:null;
      const sub=ref.subtaskId?arr(task&&task.subtasks).find(t=>String(t.id)===String(ref.subtaskId)):null;
      if(ref.subtaskId&&!sub)return null;
      const owner=sub||task||host;
      return {list:owner.notes||(owner.notes=[]),host:owner};
    }
    return null;
  }
  function applySelected(map, entry) {
    const item=entry.old, value=clone(item.value), ref=item.ref;
    if(item.kind==="calendar" && ref.retained){
      if(!map.calendarRetained)map.calendarRetained={};
      if(!map.calendarRetained[ref.date])map.calendarRetained[ref.date]={};
      map.calendarRetained[ref.date][ref.sourceKey]=value;
      // Persist merges live Calendar cells over retained data. Update the
      // matching live cell too or that merge would undo the recovery.
      const fields=String(ref.sourceKey).split(":");
      if(fields.length>=3){
        const c=Number(fields.pop()),r=Number(fields.pop());
        const node=findNodeIn(map.root,fields.join(":"));
        if(node&&node.table&&Array.isArray(node.table.cells)&&
            node.table.cells[r]&&c<node.table.cells[r].length){
          if(!Array.isArray(node.table.attach))node.table.attach=[];
          if(!Array.isArray(node.table.attach[r]))node.table.attach[r]=[];
          node.table.attach[r][c]=clone(value.host||{});
        }
      }
      return true;
    }
    if(item.kind==="calendar" && ref.datePhotos){
      if(!map.root.calendarDatePhotos)map.root.calendarDatePhotos={};
      map.root.calendarDatePhotos[ref.date]=value;return true;
    }
    // Existing ids may have moved to a different task/node since the
    // revision. Update their CURRENT location, not a stale parent.
    const target=entry.now||item;
    const slot=locateContainer(map,target);
    if(!slot)return false;
    if(item.kind==="calendar"){
      const table=slot.node.table;
      const cellRef=target.ref||ref;
      table.attach[cellRef.r][cellRef.c]=clone(value.host);
      if(table.cells&&table.cells[cellRef.r])table.cells[cellRef.r][cellRef.c]=value.text;
      return true;
    }
    const list=slot.list;
    if(!list)return false;
    const id=item.kind==="note"?ref.noteId:item.kind==="subtask"?ref.subtaskId:ref.taskId;
    const at=list.findIndex(x=>x&&String(x.id)===String(id));
    if(at>=0)list[at]=value;
    else list.splice(Math.min(ref.index||0,list.length),0,value);
    if(item.kind==="note")slot.host.note="";
    return true;
  }
  async function doRestore(full){
    if(working||!getRevision()||!currentMap())return;
    if(!full&&(!selected||!selected.restorable||selected.status==="Same"))return;
    if(typeof requireSignIn==="function"&&!requireSignIn())return;
    if(DriveDB.busy||DriveDB.pushingLocal||unsavedEdits||persistTimer||persistInFlight){
      showToast("A save or sync is running. Finish it before restoring.");return;
    }
    const source=clone(getRevision());
    const map=currentMap();
    const what=full?"the WHOLE map":'"'+selected.label+'" ('+selected.kind+')';
    if(!confirm("Restore "+what+" from "+dateTime(active.ts)+"?\n\nA separate backup of your current map will be saved first. Other current data will remain unchanged for individual restores."))return;
    working=true;restoreOneBtn.disabled=true;restoreAllBtn.disabled=true;
    try{
      // Recovery backup must finish BEFORE touching live content.
      const backup=await saveConflictCopy(map,"before recovery");
      if(!backup)throw Error("Could not save current-map backup; no changes made.");
      if(full){
        pushUndo();
        const previousLog={_editLog:clone(map._editLog||[]),_lastEditAt:mapLastEditAt(map)};
        const sourceData=clone(source);
        Object.keys(map).forEach(k=>{if(!(k in sourceData)&&k!=="id")delete map[k];});
        Object.assign(map,sourceData);
        map.id=mapId;
        map._editLog=mergeMapEditLogs(previousLog,source);
        map._lastEditAt=Math.max(mapLastEditAt(previousLog),mapLastEditAt(source));
      }else{
        pushUndo();
        if(!applySelected(map,selected))throw Error("The original location no longer exists. Use full-map restore.");
      }
      map.updatedAt=nextUpdatedAt(map);
      persist();
      if(full)await openMap(map.id);
      else {renderAll();if(calendarModal&&!calendarModal.classList.contains("hidden"))renderCalendar();}
      showToast("Recovered "+what+". Current-map backup: "+backup.title);
      // Do not discard snapshots or close automatically; let the user
      // inspect that the recovery took effect.
      rows=await journalRecoveryRevisions(mapId);
      active=rows.find(x=>x.id===active.id)||active;
      selected=null;renderRevisions();refreshCandidates();
      renderSidebar();
    }catch(e){console.error("Recovery failed",e);showToast("Recovery not applied: "+(e.message||e));}
    finally{working=false;updatePreview();}
  }
  openBtn.addEventListener("click",openWindow);
  $r("recovery-close").addEventListener("click",closeWindow);
  search.addEventListener("input",renderItems);
  filter.addEventListener("change",renderItems);
  restoreOneBtn.addEventListener("click",()=>doRestore(false));
  restoreAllBtn.addEventListener("click",()=>doRestore(true));
  modal.addEventListener("click",e=>{if(e.target===modal)closeWindow();});
})();
