# NIP-05 目錄服務 — 設計文件(SSOT)

> **2026-09-09 勘誤**:識別字網域改為產品網域 **`creds.id`**(`<name>@creds.id`,目錄掛在 `https://creds.id/.well-known/nostr.json` 與 `/id/*`),與分享連結 `creds.id/@<name>` 同一個 host。本文以下所有 `solidarity.gg` / `app.solidarity.gg` 一律讀作 `creds.id`;機制不變。部署方式見 README「NIP-05 directory」一節(獨立 worker `solidarity-id`,`bun run deploy:nip05`)。

> 2026-08-13 · 以新版 v2 產品規格為主:本 backend 提供 **opt-in NIP-05 目錄**,連結人類可讀 ID(`<name>@solidarity.gg`)與 Nostr pubkey,並支撐真正的短網址 `https://app.solidarity.gg/@<name>`。
> 對應 app repo 規格:`airmeishi/docs/ref/01-spec-verified-page.md` §8(HandleResolver 已預留 NIP-05 lane)。

## 0. 產品定位(不可違反)

1. **Opt-in + 明確同意**:預設分享 = 純 pubkey(npub / did:key / fragment QR),**完全不經本伺服器**。只有使用者明確同意「把我的 pubkey 與名稱發佈到公開目錄」才註冊。同意的密碼學證據 = 使用者用自己的 Nostr key 簽的 NIP-98 請求(見 §3)。
2. **軟依賴**:本服務與 proof-fetch worker 同類 — 掛掉時 NIP-05 徽章降 `stale`,頁面、QR、pubkey 驗證路徑一切照常。viewer 不得把本服務當必經之路。
3. **最小信任面**:本服務只儲存 `name → pubkey` 指標,不儲存 profile、不簽發任何憑證、無 PII(無 email、無 IP 持久化)。伺服器被攻破最壞情況 = handle 指向錯的 pubkey;但 viewer 做**雙向驗證**(nostr.json 指向 pubkey ∧ 該 pubkey 的 kind-0 `nip05` 欄位宣稱同一 handle),單向不畫綠勾 — 攻擊者無法偽造 profile 簽章。
4. **綠勾語意不變**:handle 只是指標,不是背書。「已驗證」仍只代表「控制該金鑰」。

## 0.5 Grill 決議(2026-07-29 — 取代本文件先前的相衝條款)

- **G1 name 收緊**:`^[a-z0-9]{3,30}$` —— v1 不發放任何符號。
  - 移除 `.`:`alice.dev` 同時是合法 nip05 name 與合法 atproto handle 形狀,而 app/web 的 `matchHandleResolver` 是 first-match-wins(ENS → ATProto → DNS),`/@alice.dev` 會被 ATProto resolver 先吃掉、解到錯的人。收緊後 resolver 的 `matches` 成為純語法分割:**有點 → atproto/ens/dns,無點 → nip05**,結構上不可能相撞。
  - 最短 3:短 ID 也屬於免費核心功能,不建付費名稱池。
- **G2 短連結主形態**:`https://app.solidarity.gg/@<name>`(裸名,無 `nip05:` 前綴)。`/@<無點名字>` 這個 namespace 今天沒有任何 resolver 認領,零碰撞。
- **G3 永久 tombstone、不回收**:released 的 name **永不重新分配給不同的 pubkey**(原 pubkey 可無限期 reclaim)。取代原 §4 的 30 天 quarantine-then-delete。
  - 理由:唯有永不回收,`/@name` 才能印在名片上 —— 這正是 app repo 研究筆記 §2.5 判定「印刷物只能用 fragment」的那條限制,而自營 namespace 的價值就在於能解除它。
- **G4 恢復機制純密碼學驗證、無 admin 後門**(見 §3.5):**不存在任何人工核准端點**,證據為零時一律拒絕。
  - 理由:任何人工恢復路徑都是繞過金鑰的後門,而 viewer 的雙向驗證**結構上擋不住它** —— 攻擊者把 name 改指到自己的 pubkey 後,自己的 kind-0 也寫上同一個 identifier,兩邊完全自洽,綠勾照畫。雙向檢查只證明「當下綁定自洽」,不證明「還是同一個人」。
- **G5 rebind 永久留痕**:`rebind_generation >= 1` 的 name,viewer 永久顯示「曾經重新綁定」標記,近 90 天內徽章降 `stale`。
  - 理由:真正的受害者是舊名片持有人 —— 他們掃到同一個 `/@name` 但背後已換人,雙向驗證對他們不會報警,永久標記是唯一能讓他們察覺的管道。與 repo 既有的「誠實五態、永不假綠」同一條原則。
- **G6 護照 / ZK 恢復本版不做**:三個實證阻礙 ——(a)`packages/shared/src/badges/` 沒有 passport badge,護照現在沒有任何東西進入已發布的 record,恢復時無從比對;(b)`apps/expo/src/zk/passportAnchorStore.ts` 的 anchor 是**每次安裝隨機**,設計目的正好是防止跨安裝辨識;(c)要能比對就必須發布跨安裝穩定的 nullifier,那等於公開一個全球唯一的人類識別碼。再加上 Android libc++ ABI bug 會讓 ZK 靜默降級成 SD-JWT fallback(`trustLevel: 'white'`)—— **降級的 fallback 被當恢復憑據接受 = 直接把 handle 送人**。
- **G7 改名與舊網址**:每個 pubkey 90 天內最多改名一次。舊 `/@name` 在 90 天內用 client-side redirect 導向新 name;期滿後停止解析,但仍是原 pubkey 的永久 tombstone,永不轉讓第二人。
- **未決(不阻擋本次實作)**:ENS 恢復 lane(本次只做 DNS)、handle 轉移 API。

## 1. API 面

### 1.1 `GET /.well-known/nostr.json?name=<name>` — 公開解析(NIP-05 標準)

- 回應(200,`application/json`,CORS `*` 必須):
  ```json
  { "names": { "<name>": "<64-hex-pubkey>" }, "relays": { "<64-hex-pubkey>": ["wss://..."] } }
  ```
- `name` 不存在 → 200 + `{"names":{}}`(不 404,行為可快取)。
- `name` 缺省或 `name=_` → 回營運者保留名 `_`(若未設定則空)。
- 大小寫不敏感:查詢先 lowercase。
- **Edge cache**:`Cache-Control: public, max-age=300` + `caches.default`(key = 完整 URL);任何 mutation 對受影響 name 做 cache purge(rename 要 purge 新舊兩個 name)。

### 1.2 `POST /id/register` — 註冊 / 改名(NIP-98 auth)

- Header:`Authorization: Nostr <base64(event JSON)>`(NIP-98,見 §3)。
- Body:
  ```json
  { "name": "alice", "relays": ["wss://relay.primal.net"], "consent": true }
  ```
  - `consent` 必須字面為 `true`,否則 400 `consent_required` — 這讓簽名事件(含 body hash)成為可稽核的同意收據。
  - `relays` 選填,≤10 條,每條必須 `wss://` 開頭、長度 ≤ 200。
- 語意:**每個 pubkey 同時只有一個 active name**。已擁有 name 再註冊新 name = rename:舊 name 進永久 tombstone,並在 90 天內 redirect 到新 name;新 name 生效,同一 D1 batch 內原子完成。
- 錯誤:400 `invalid_name` / `consent_required`、401 `invalid_auth`(NIP-98 驗證失敗,附 `detail` 區分 expired / bad_sig / url_mismatch / replay)、409 `name_taken`、429 `rename_too_soon`(附 `retryAt`)。
- 成功:200 `{ "name": "alice", "pubkey": "<hex>", "identifier": "alice@solidarity.gg" }`。同名同 pubkey 重複註冊 = 冪等更新 relays,不計入改名次數…例外:計次只數「name 實際變更」的 register。

### 1.3 `DELETE /id` — 註銷(NIP-98 auth)

- 釋放呼叫者 pubkey 目前的 active name → 永久 tombstone;不產生 redirect,不重新分配給其他 pubkey。
- 冪等:沒有 active name 也回 200 `{ "released": null }`。

### 1.4 `GET /id/availability?name=<name>` — 公開查詢(不快取)

- 200 `{ "name": "alice", "available": false, "reason": "taken" }`,`reason ∈ invalid | reserved | taken | tombstoned`;available=true 時無 reason。
- `Cache-Control: no-store`(避免 edge cache 造成註冊前誤判)。

### 1.45 `GET /id/history?name=<name>` — 公開查詢 rebind 痕跡(G5,不快取)

- 200 `{ "name", "status": "active"|"redirected"|"released", "redirectTo": string|null, "redirectUntil": number|null, "rebindGeneration": number, "reboundAt": number|null }`;未註冊過 → 404。`redirected` 只在 90 天有效窗內回傳,期滿後對外為 `released`。
- `Cache-Control: no-store` + CORS `*`。**刻意不快取**:其他端點快取無妨,但過期的答案會**隱藏**剛發生的 rebind —— 正是這個標記存在要防的那種失敗。
- viewer 必須把 `rebindGeneration >= 1` 呈現為永久標記,`reboundAt` 在 90 天內則徽章降 `stale`。

### 1.5 `POST /id/recover` — 遺失金鑰後重新綁定(NIP-98 auth,純密碼學驗證)

- Header:`Authorization: Nostr <base64(event JSON)>`,**由「新」的 Nostr key 簽**(NIP-98,同 §3)。
- Body:
  ```json
  {
    "name": "alicex",
    "oldRecordJws": "<compact JWS,舊 DID 簽>",
    "newRecordJws": "<compact JWS,新 DID 簽>",
    "binding": "dns:example.com",
    "consent": true
  }
  ```
  - **為什麼要兩份 record**:root DID 是 P-256、Nostr key 是 secp256k1,同種子但不同曲線、彼此推導不出來。「網域現在指向我」是 DID 層的事實,「這個請求是我簽的」是 npub 層的事實,兩把金鑰都必須出場:新 record 由新 DID 簽且宣稱新 npub,而 NIP-98 信封由該 npub 簽。
- 語意:證明「我控制舊 record 曾經綁定過的那個外部憑據」→ 把 `name` 重新指向呼叫者的 pubkey。**沒有任何人工核准路徑**;§3.5 六步驗證缺一即 403。
- 若呼叫者的新金鑰已持有其他 active name(掉種子後重新開始的常見情況),該 name 會在**同一個 batch** 內被 release(進 tombstone),否則 `(pubkey) WHERE status='active'` 的唯一索引會擋掉每一次真實的恢復。
- 成功:200 `{ "name", "pubkey", "identifier", "rebindGeneration": 1, "releasedName": string|null }`。
- 錯誤:400 `invalid_name` / `invalid_binding` / `invalid_record` / `consent_required`、401 `invalid_auth`(同 §3)、404 `name_not_found`(含「該 name 是 tombstone」——刻意不可恢復)、409 `state_changed`、403 `recovery_denied`(附 `detail`:`jws_invalid` / `pubkey_mismatch` / `binding_not_claimed` / `binding_not_transferred` / `binding_unreachable`)、429。

**v1 不做**:反向查詢(pubkey→name;kind-0 的 `nip05` 欄位已是宣告面,反向 API 只會方便爬蟲)、did 儲存、多 name、**admin API / 任何人工核准端點(G4 明令禁止)**、付費保留名、ENS 恢復 lane。

## 2. 資料模型(D1 / drizzle)

```ts
// nip05_handles
name       text PK          // lowercase, 唯一
pubkey     text NOT NULL    // 64-hex, x-only secp256k1; partial-unique: 同一 pubkey 只能有一筆 active
relays     text NOT NULL    // JSON string[], default "[]"
status     text NOT NULL    // 'active' | 'released' | 'redirected'(後兩者都是永久 tombstone)
createdAt  integer NOT NULL // epoch seconds
updatedAt  integer NOT NULL
releasedAt integer          // status!='active' 時必填
redirectTo text             // status='redirected' 時的新 name
redirectUntil integer       // rename + 90 天;期滿後不再導向
rebindGeneration integer NOT NULL DEFAULT 0  // G5:>=1 代表曾經歷 §3.5 恢復
reboundAt  integer          // 最近一次恢復的時間;generation=0 時為 NULL

// nip05_audit — 稽核 + NIP-98 replay guard 二合一
eventId    text PK          // NIP-98 event.id — 重複插入 = replay → 拒絕
action     text NOT NULL    // 'register' | 'release' | 'recovery_rebind'
name       text NOT NULL
pubkey     text NOT NULL    // 該動作生效後的持有者 pubkey
authEvent  text NOT NULL    // 完整 NIP-98 event JSON(同意收據);恢復流程由「新」key 簽,故仍為 NOT NULL
createdAt  integer NOT NULL
```

- 同一 pubkey 的 active 唯一性用 partial unique index:`CREATE UNIQUE INDEX ... ON nip05_handles (pubkey) WHERE status = 'active'`(D1/SQLite 支援)。
- **tombstone 的列永不刪除**(G3):`status='released'` 的列保留原 `pubkey`,原持有者可無限期 reclaim(register 同名 → 復活該列),其他 pubkey 永遠得到 `name_taken`。cron 只清 audit,不再清 handles。
- **恢復不需要任何新的儲存**:舊 record 由申請人自行提供,而既有的 `pubkey` 欄位就是讓它不可偽造的錨點(§3.5 第 3 步)。刻意不建 `name → 外部綁定` 的快照表 —— 那會讓本服務開始累積使用者資料,違反 §0.3。
- migration:只有 `drizzle/0001_nip05.sql`。G1/G3/G5 直接寫進它而非疊一個 0002 —— 本功能尚未 commit 也未 deploy(§5 的 zone 綁定仍是未完成的 ops 項),零資料需要遷移,而 SQLite 無法 ALTER 既有 CHECK 約束,疊加只會換來一次無謂的 table rebuild。schema 在 `src/db/schema.ts`。

## 3. 認證:NIP-98(kind 27235)

驗證步驟(全部通過才放行;失敗一律 401 + 錯誤碼,不 throw):

1. `Authorization: Nostr <base64>` → decode 成 event JSON。
2. `kind === 27235`。
3. `created_at` 距現在 ±60 秒內(app 端時鐘偏差要能從 `detail: "expired"` 辨識)。
4. `u` tag === 請求的 canonical URL(`https://` + host + path,不含 query 時就不含;從 `c.req.url` 重建並比對)。`method` tag === HTTP method。
5. 有 body 的請求(POST):`payload` tag === sha256(raw body) 的 hex。DELETE 無 body → 不要求 `payload`。
6. event id 正確(NIP-01 serialization 的 sha256)∧ BIP340 schnorr 簽章對 `pubkey` 有效。
7. **Replay guard**:mutation 成功時把 event id 插入 `nip05_audit`(PK 衝突 → 401 `replay`)。

- 密碼學:`@noble/curves`(schnorr/secp256k1)+ `@noble/hashes`(sha256)— 純 JS、Workers 相容、bundle 小。**不要**引入 nostr-tools。
- 現有 inbox 的 Ed25519 驗簽(`lib/inbox/crypto.ts`)與此無關,不要共用、不要改動。

## 3.5 恢復:遺失助記詞後的重新綁定(G4)

### 適用範圍 —— 先分清楚兩種「忘記」

- **(A) 換手機/重裝,助記詞還在**:Nostr key 由 root 助記詞推導(`deriveSecp256k1Scalar(mnemonic, HKDF_INFO_NOSTR)`,app `src/nostr/userKey.ts`),同助記詞 ⇒ **同一個 npub**(已 pin 在 parity vector `derive.json` 的 `nostrPubkeyHex`)。handle 從未斷過,**本服務不需要任何動作**。
- **(B) 助記詞也丟了**:did:key 身分、憑證、iCloud 備份(SOLB v2 由 `deriveBackupKeyFromMnemonic` 加密)全部同時失效。此時 handle 不是「找回舊身分」,而是**把一個舊名字指向一個全新的身分**。本節只處理 (B)。

### 六步驗證(全過才 rebind,缺一即拒,無人工覆寫)

申請人提供舊的 profile JWS —— 來源不限:Nostr relay、某個把他存進 People 的舊聯絡人、或他自己印在名片上的 fragment QR。

1. **NIP-98 驗證**,由**新** pubkey 簽(§3 全套:kind/時窗/`u`/`method`/`payload` hash/id/schnorr/replay guard)。
2. **舊 record 的 JWS 簽章有效**:`verifyCompact(oldRecordJws, payload.did)` —— ES256 / P-256,header 必須恰好 `{alg, kid}`、`kid === did + '#0'`、簽章 `prehash: false`(訊息代表已是 SHA-256,再雜湊一次會全錯)。移植自 app repo `packages/shared/src/{jws,identity/didKey}.ts`,**逐字對齊,不得自行簡化**;以 app 的 golden vectors(`vectors/{jws,didkey}.json`)對拍。
3. **舊 record 自稱的 npub === 目錄裡該 name 現在綁的 pubkey**。這一步是整個機制的**錨**:它讓「申請人提供的舊 record」變得不可偽造,而且用的是我們**本來就存著**的 `pubkey` 欄位,不需要任何額外儲存。對接點是 record 自己 `alsoKnownAs` 裡的 `nostr:<npub>` claim —— 與 viewer 既有的 anti-substitution 閘同一條線。(record 若宣稱兩個 npub 則整筆拒絕:哪把金鑰代表它變成猜測。)
4. **舊 record 宣稱過該外部綁定**:`binding`(本版僅 `dns:<domain>`)必須出現在舊 record 的 `alsoKnownAs`。
5. **新 record 有效、屬於 NIP-98 簽署者,且重新宣稱同一綁定**:`verifyCompact(newRecordJws, ...)` 通過、其 `nostr:` claim === NIP-98 的 pubkey、其 `alsoKnownAs` 也含 `dns:<domain>`(讓恢復後的頁面立刻是雙向自洽的,與徽章規則一致)。新舊 DID **必須不同** —— 相同代表金鑰沒丟,那是改名,該走 `/id/register`。
6. **該外部綁定現在指向新身分**:DoH 查 `_did.<domain>` TXT(失敗則退回 `https://<domain>/.well-known/did`,**https-only 且 URL 由已驗證的 hostname 組出、絕不取自 TXT 內容**),解析出的 DID 必須等於**新** record 的 DID。TXT 出現互相衝突的 pointer 一律 fail closed,不退回 `.well-known` 另尋答案。

通過後於**同一個 D1 batch** 內:(必要時先 release 呼叫者現有的 active name)→ 更新 `pubkey`、`rebind_generation += 1`、`rebound_at = now`、寫入 `nip05_audit`(`action='recovery_rebind'`)、purge 受影響 name 的 edge cache。批次以 CHECK 約束的 `action` 欄位做交易斷言:狀態在中途被動過就寫入 `'invalid'`,整批 abort。

### 明確不做

- **沒有 admin 端點、沒有工單、沒有人工核准。** 舊 record 全世界都拿不出來時(relay 清了、無人存過、名片也丟了),可驗證的證據客觀上是零,此時的人工審核在密碼學上等於擲骰子、實務上等於「誰的故事編得好誰拿走」——而付費 ID 會讓這條路被精確地當成商品攻擊。答案是:**舊 name 永久 tombstone,任何人都拿不走它**,使用者註冊一個新 name。
- 不接受「請申請人指出該 handle 過去發布過的 event id / profile 內容」作為憑據 —— relay 上全是公開資料,攻擊者查得到的跟本人一樣多。

## 4. 政策

- **name 規則**(G1):lowercase 後必須符合 `^[a-z0-9]{3,30}$`;不含任何符號或 Unicode。NIP-05 identifier 全字 = `<name>@solidarity.gg>`;產品短網址 = `https://app.solidarity.gg/@<name>`。
- **保留名單**(const 檔,code review 即可增修):`_`, `admin`, `administrator`, `root`, `solidarity`, `airmeishi`, `support`, `help`, `security`, `abuse`, `www`, `mail`, `postmaster`, `nostr`, `verify`, `verified`, `id`, `official`, `pay`, `billing`, `api`, `dev`, `team`, `staff`。
- **Tombstone(取代 quarantine,G3)**:released 的 name **永久保留該列、永不重新分配**。原 pubkey 可**無限期** reclaim(register 同名 → 直接復活該列,不算改名);其他 pubkey 查 availability 恆得 `tombstoned`、register 恆得 409。這同時擋掉「註銷即被搶註冒充」,並讓 `/@name` 成為可印在名片上的短連結。
- **改名頻率**:單一 pubkey 90 天內 name 實際變更 ≤ 1 次;首次註冊與同名冪等更新不算改名。
- **IP 護欄**:全域已有 100/60s;`/id/register` 另有精確的 per-IP 限流:Durable Object `Nip05WriteLimiter`(5/60s sliding window,`src/lib/writeLimiter.ts`)。ratelimit binding 只是近似值,2026-11-04 實測線上從不回 429;zone 前面另有一條 WAF rate-limiting rule。
- **資料保存**:audit 列保存 90 天後由 cron 清除(同意收據保留窗)。**`nip05_handles` 的列一律不刪**(G3 tombstone)—— cron 只清 audit。掛進現有 hourly cron(`src/schedules/index.ts`),與 inbox cleanup 並列、互不影響(單邊失敗不可拖垮另一邊)。
- **恢復頻率**:`/id/recover` 與 register 共用同一個 `Nip05WriteLimiter` 計數(5/60s per IP);單一 name 的 `rebindGeneration` 不設上限,但每次都永久累加且對外可見(G5)。

## 5. 部署(ops,不在 codex 範圍)

- NIP-05 要求 nostr.json 在 identifier 網域本體 → zone route:`solidarity.gg/.well-known/nostr.json*` 與 `solidarity.gg/id/*` 指到本 worker(viewer 靜態頁不受影響,只切這兩個 path)。wrangler.jsonc 先加 `routes`(zone 未掛到帳號前 deploy 會失敗 — 屬 ops 確認項)。
- `wrangler d1 migrations apply airmeishi_inbox`(沿用同一 D1 database)。
- 無新 secret。

## 6. App / Web 端契約(後續任務,不在本 repo)

- App 同意頁(明確列出:公開目錄、我們的伺服器持有映射、隨時可刪)→ 同意後以 nostr key 簽 NIP-98 註冊;kind-0 profile 寫入 `nip05: "<name>@solidarity.gg"`(補上雙向);註銷時清掉 kind-0 欄位。後端離線不阻擋本機 onboarding,但不得顯示或複製尚未註冊成功的 `/@name`。
- 不同意 → UI 維持 npub / QR 分享,永不提示第二次(設定內可再開)。
- Viewer `HandleResolver` 接 nip05 lane(`app.solidarity.gg/@<name>` → `solidarity.gg` nostr.json/history → pubkey + relay hints → relay 取 profile → kind-0 `nip05` 雙向驗證)。舊 name 在 history 回傳有效 redirect 時導向 canonical name。
- 分享與 QR 預設只推薦已註冊且雙向發布完成的短網址;自包含的長 fragment 只放「其他格式 / 離線備援」。
- **`Nip05HandleResolver` 的 `matches` 只吃無點裸名**(G1):有點的一律讓給 atproto/ens/dns。加進 `DEFAULT_HANDLE_RESOLVERS` 後 `deeplink/parser.ts` 無需改動 —— `parseVerifiedHandleRoute` 已經是泛型走 registry。連帶要放寬 `apps/expo/src/scan/verifiedPageHandler.ts` 的 `VerifiedHandleBinding.scheme`(目前 `Exclude<HandleScheme,'nip05'>`)與 `meProfileModel.ts` 的 `HandleShareScheme`。
- **G5 標記是 viewer 的硬需求**:解析 nip05 handle 時一併讀 `rebindGeneration`,`>= 1` 永久顯示「曾經重新綁定」,`reboundAt` 在 90 天內則徽章降 `stale`。**沒有這個標記就不要上線恢復功能** —— 那等於提供一條靜默的冒名管道。
- Web viewer 的 CSP `connect-src` 需加 `https://solidarity.gg`(跨源:頁面在 `app.solidarity.gg`,目錄在 apex),對應 §1.1 的 CORS `*`。

## 7. 驗證(本 repo)

- `package.json` 加 `"typecheck": "tsc --noEmit"`;`bun test` 跑純函式單元測試(name 驗證全邊界、NIP-98 驗證器:好向量 + 壞簽章 / 過期 / url 不符 / payload 不符 / kind 錯誤,向量在測試內固定寫死,不打網路)。
- 完成標準:`bun run typecheck` && `bun test` 綠、`wrangler dev` 下四條 endpoint 手測通過。
