"use strict";
const fs=require("node:fs"),path=require("node:path"),test=require("node:test"),assert=require("node:assert/strict");
const read=p=>fs.readFileSync(path.resolve(__dirname,"..",p),"utf8");
const side=read("js/06-state-sidebar-layout.js"),boot=read("js/19-browsers-and-boot.js");
const drive=read("js/02-google-drive-sync.js"),safe=read("js/03-sync-safety-merge-lock.js");
test("Sidebar lists verified Drive IDs only and hides local previews",()=>{
 assert.match(side,/DriveDB\.cloudCatalogReady === true/);
 assert.match(side,/const visibleMaps = visibleVerifiedMaps\(\)/);
 assert.match(side,/DriveDB\.cloudCatalogIds\.has\(m\.id\)/);
 assert.doesNotMatch(side,/return startupLocalPreview \|\|/);
 assert.match(boot,/cloudOnlyMapList = hadDriveSession/);
 assert.doesNotMatch(boot,/await openMap\(toOpen\)/);
 assert.match(read("style.css"),/body\.signed-out #mindmap-list\{display:none!important\}/);
});
test("Old cached maps cannot become cloud files without explicit creation",()=>{
 assert.match(drive,/pendingCloudCreates: new Set\(\)/);
 assert.match(drive,/async rememberCloudCreate\(id\)/);
 assert.match(drive,/!this\.fileIndex\[id\] && !this\.pendingCloudCreates\.has\(id\)/);
 assert.match(drive,/if \(!known\) return includeNew && this\.pendingCloudCreates\.has\(m\.id\)/);
 assert.match(drive,/this\.cloudCatalogIds = new Set\(seenRemoteIds\)/);
 assert.match(drive,/await this\.finishCloudCreate\(id\)/);
 assert.match(side,/await DriveDB\.rememberCloudCreate\(m\.id\)/);
 assert.match(boot,/await DriveDB\.loadPendingCloudCreates\(\)/);
});
test("Missing Drive revisions cannot silently replace unsaved work",()=>{
 assert.match(drive,/this\.cloudCatalogReady = false;\s*this\.conflictDetected = true;[\s\S]*?throw new Error/);
 assert.match(drive,/!snapshot \|\| !sameSyncContent\(existing, snapshot\)/);
 assert.match(boot,/if \(!cloudOnlyMapList && FolderDB\.dir/);
 assert.match(boot,/if \(!cloudOnlyMapList && mapsReadyToShow\(\)\)/);
 assert.match(safe,/return mapsReadyToShow\(\) && !DriveDB\.conflictDetected/);
});
test("v762 browsers and PWAs request the latest sources",()=>{
 assert.match(read("index.html"),/app\.js\?v=762/);
 assert.match(read("index.html"),/style\.css\?v=762/);
 assert.match(read("sw.js"),/branchline-pwa-v762/);
 assert.match(read("sw.js"),/subtask-focus-mode\.js\?v=762/);
});
