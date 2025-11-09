const CONFIG = {
  inboxFolderId: "1ADisWsmPc81lqlV7-NWAK4WIeN9K_TGZ",
  okFolderId: "12CurPdxu1BlWC0k_9FTdOuYcTgCNO3_R",
  ngFolderId: "1sErg8MjdKFuxVzAmJ5BTkBIykohCl4E3",
  slackBotToken: PropertiesService.getScriptProperties().getProperty("SLACK_BOT_TOKEN") || "",
  slackSigningSecret: PropertiesService.getScriptProperties().getProperty("SLACK_SIGNING_SECRET") || "",
  slackChannelId: PropertiesService.getScriptProperties().getProperty("SLACK_CHANNEL_ID") || "",
};

// ===== サイネージ設定（表示用） =====
const SIGNAGE_CONFIG = {
  FOLDER_ID: '12CurPdxu1BlWC0k_9FTdOuYcTgCNO3_R', // ok等、表示対象フォルダのIDに変更可
  EXPIRES_MS: 24 * 60 * 60 * 1000,
  ALLOW_ORIGIN: '*',
};

const META_KEYS = {
  comment: "comment",
  uploadedAt: "uploadedAt",
  status: "status",
};

const STATUS = {
  pending: "PENDING",
  approved: "OK",
  rejected: "NG",
};

function doPost(event) {
  // 最初に必ずログを出力（doPost が呼ばれているか確認）
  console.log("[doPost] 関数が呼ばれました", new Date().toISOString());
  paperLog("[doPost] 関数が呼ばれました");
  
  try {
    paperLog("[doPost] リクエスト受信", "contentType=" + (event?.postData?.type || "なし"), "hasPostData=" + !!event?.postData);
    paperLog("[doPost] CONFIG確認", "slackBotToken=" + (CONFIG.slackBotToken ? "設定済み(" + CONFIG.slackBotToken.substring(0, 10) + "...)" : "未設定"), "slackChannelId=" + (CONFIG.slackChannelId || "未設定"));
    
    // Slack Interactivity リクエストかどうかを判定
    const contentType = event?.postData?.type || "";
    const isSlackRequest = contentType === "application/x-www-form-urlencoded" && event?.parameter?.payload;
    
    if (isSlackRequest) {
      paperLog("[doPost] Slack Interactivity リクエストとして処理");
      return handleSlackInteractivity(event);
    }

    // 画像アップロード処理
    paperLog("[doPost] 画像アップロード処理を開始");
    if (!event?.postData?.contents) {
      paperLog("[doPost] エラー: リクエストデータが空");
      return buildErrorResponse("リクエストデータが空です。", 400);
    }

    const payload = JSON.parse(event.postData.contents);
    paperLog("[doPost] ペイロード解析完了", "filename=" + (payload.filename || "なし"), "hasPhotoBase64=" + !!payload.photoBase64);
    
    validatePayload(payload);

    const folder = DriveApp.getFolderById(CONFIG.inboxFolderId);
    const filename = buildFileName(payload);
    paperLog("[doPost] ファイル作成開始", "filename=" + filename, "folderId=" + CONFIG.inboxFolderId);
    
    const blob = createBlob(payload, filename);
    const file = folder.createFile(blob);
    
    // メタデータをファイルの説明に JSON 形式で保存
    const metadata = {
      comment: payload.comment || "",
      uploadedAt: payload.timestamp || new Date().toISOString(),
      status: STATUS.pending,
    };
    const description = payload.comment || "";
    file.setDescription(description);
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
    
    // setProperty は使えないため、メタデータはファイル名や説明に含める
    // 必要に応じて、後で Drive API v3 を使ってプロパティを設定することも可能
    paperLog("[doPost] ファイル作成完了", "fileId=" + file.getId(), "fileName=" + file.getName(), "metadata=" + JSON.stringify(metadata));
    paperLog("[doPost] Slack通知を開始");

    notifySlack(file, payload);

    paperLog("[doPost] 処理完了", "fileId=" + file.getId());
    return buildJsonResponse({ ok: true, fileId: file.getId(), id: file.getId() });
  } catch (err) {
    paperLog("[doPost] エラー発生", "error=" + String(err), "stack=" + (err.stack || "なし"));
    console.error(err);
    return buildErrorResponse(err.message || "不明なエラーが発生しました。");
  }
}

function validatePayload(payload) {
  if (!payload) {
    throw new Error("JSON ボディが解析できません。");
  }
  if (!payload.photoBase64) {
    throw new Error("画像データが含まれていません。");
  }
  if (!payload.mimeType) {
    throw new Error("MIME タイプが指定されていません。");
  }
  if (!payload.filename) {
    throw new Error("ファイル名が指定されていません。");
  }
}

function createBlob(payload, filename) {
  let binary;

  try {
    binary = Utilities.base64Decode(payload.photoBase64);
  } catch (err) {
    throw new Error("画像データのデコードに失敗しました。");
  }

  return Utilities.newBlob(binary, payload.mimeType, filename);
}

function buildFileName(payload) {
  const time = payload.timestamp ? new Date(payload.timestamp) : new Date();
  const iso = Utilities.formatDate(time, Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  const safeName = payload.filename.replace(/[^\w.\-]/g, "_");
  return `${iso}-${safeName}`;
}

function notifySlack(file, payload) {
  console.log("[notifySlack] 関数が呼ばれました", "fileId=" + file.getId(), "fileName=" + file.getName());
  paperLog("[notifySlack] 開始", "fileId=" + file.getId(), "fileName=" + file.getName());
  
  // Bot Token が設定されている場合は Block Kit 形式で投稿
  if (CONFIG.slackBotToken && CONFIG.slackChannelId) {
    console.log("[notifySlack] Block Kit 形式で投稿を試みます", "botToken設定=" + !!CONFIG.slackBotToken, "channelId=" + CONFIG.slackChannelId);
    paperLog("[notifySlack] Block Kit 形式で投稿を試みます", "botToken=" + (CONFIG.slackBotToken ? "設定済み" : "未設定"), "channelId=" + CONFIG.slackChannelId);
    postPhotoToSlackWithBlockKit(file, payload);
    return;
  }

  // Bot Token が未設定の場合はスキップ
  paperLog("[notifySlack] Bot Token が未設定のため、Slack通知をスキップします");
}

function postPhotoToSlackWithBlockKit(file, payload) {
  console.log("[postPhotoToSlackWithBlockKit] 関数が呼ばれました", "fileId=" + file.getId(), "fileName=" + file.getName());
  paperLog("[postPhotoToSlackWithBlockKit] 開始", "fileId=" + file.getId(), "fileName=" + file.getName());
  
  const fileUrl = `https://drive.google.com/file/d/${file.getId()}/view`;
  const comment = payload.comment || "（なし）";
  
  console.log("[postPhotoToSlackWithBlockKit] リクエスト準備", "channelId=" + CONFIG.slackChannelId, "botToken=" + (CONFIG.slackBotToken ? "設定済み" : "未設定"));
  paperLog("[postPhotoToSlackWithBlockKit] リクエスト準備", "channelId=" + CONFIG.slackChannelId);
  
  // ステップ1: 画像をSlackにアップロード
  console.log("[postPhotoToSlackWithBlockKit] 画像アップロード開始");
  paperLog("[postPhotoToSlackWithBlockKit] 画像アップロード開始");
  
  const blob = file.getBlob();
  const uploadResp = UrlFetchApp.fetch("https://slack.com/api/files.upload", {
    method: "post",
    headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
    payload: {
      channels: CONFIG.slackChannelId,
      file: blob,
      filename: file.getName(),
      initial_comment: `*新着写真*\n*${escapeMrkdwn(file.getName())}*\nコメント: ${escapeMrkdwn(comment)}\n${new Date().toLocaleString("ja-JP")}\n\n<${fileUrl}|📷 Driveで画像を開く>`,
    },
    muteHttpExceptions: true,
  });

  const uploadCode = uploadResp.getResponseCode();
  const uploadText = uploadResp.getContentText();
  console.log("[postPhotoToSlackWithBlockKit] 画像アップロードレスポンス", "statusCode=" + uploadCode, "response=" + uploadText.substring(0, 500));
  paperLog("[postPhotoToSlackWithBlockKit] 画像アップロードレスポンス", "statusCode=" + uploadCode);

  const uploadData = JSON.parse(uploadText || "{}");
  if (!uploadData.ok) {
    console.error("[postPhotoToSlackWithBlockKit] 画像アップロードエラー", "error=" + uploadText);
    paperLog("[postPhotoToSlackWithBlockKit] 画像アップロードエラー", "error=" + uploadText);
    return;
  }

  console.log("[postPhotoToSlackWithBlockKit] 画像アップロード成功", "file_id=" + (uploadData.file?.id || "なし"));
  paperLog("[postPhotoToSlackWithBlockKit] 画像アップロード成功");

  // ステップ2: ボタンを別のメッセージとして投稿
  const blocks = [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "OK → 公開へ" },
          style: "primary",
          action_id: "ok_move",
          value: JSON.stringify({ fileId: file.getId(), name: file.getName() }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "NG（理由入力）" },
          style: "danger",
          action_id: "ng_reason",
          value: JSON.stringify({ fileId: file.getId(), name: file.getName() }),
        },
      ],
    },
  ];

  console.log("[postPhotoToSlackWithBlockKit] ボタンメッセージ投稿開始");
  const buttonResp = UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method: "post",
    headers: { 
      Authorization: "Bearer " + CONFIG.slackBotToken,
      "Content-Type": "application/json; charset=utf-8"
    },
    payload: JSON.stringify({
      channel: CONFIG.slackChannelId,
      text: "審査ボタン",
      blocks: blocks,
    }),
    muteHttpExceptions: true,
  });

  const buttonCode = buttonResp.getResponseCode();
  const buttonText = buttonResp.getContentText();
  console.log("[postPhotoToSlackWithBlockKit] ボタン投稿レスポンス", "statusCode=" + buttonCode, "response=" + buttonText.substring(0, 500));
  paperLog("[postPhotoToSlackWithBlockKit] ボタン投稿完了");

  const buttonData = JSON.parse(buttonText || "{}");
  if (!buttonData.ok) {
    console.error("[postPhotoToSlackWithBlockKit] ボタン投稿エラー", "error=" + buttonText);
    paperLog("[postPhotoToSlackWithBlockKit] ボタン投稿エラー", "error=" + buttonText);
  }
}

function doGet(event) {
  const fn = event?.parameter?.fn;
  if (fn) {
    // ===== サイネージAPI (list / img64 / image) =====
    try {
      if (fn === 'list') return handleList_();
      if (fn === 'img64') return handleImg64_(event);
      if (fn === 'image') return handleImage_(event);
      return ContentService.createTextOutput(JSON.stringify({ error: 'unknown fn' }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ===== 既存: 承認/非承認の移動アクション =====
  const action = event?.parameter?.action;
  const fileId = event?.parameter?.fileId;

  if (!action || !fileId) {
    return HtmlService.createHtmlOutput("パラメータが不足しています。");
  }

  try {
    if (action === "moveToOk") {
      moveFile(fileId, STATUS.approved);
      return HtmlService.createHtmlOutput("OK フォルダへ移動しました。");
    }

    if (action === "moveToNg") {
      moveFile(fileId, STATUS.rejected);
      return HtmlService.createHtmlOutput("NG フォルダへ移動しました。");
    }

    return HtmlService.createHtmlOutput("不明なアクションです。");
  } catch (err) {
    console.error(err);
    return HtmlService.createHtmlOutput("処理中にエラーが発生しました。");
  }
}

function doOptions() {
  return buildCorsResponse();
}

function moveFile(fileId, status) {
  console.log("[moveFile] 開始", "fileId=" + fileId, "status=" + status);
  paperLog("[moveFile] 開始", "fileId=" + fileId, "status=" + status);
  
  try {
    const file = DriveApp.getFileById(fileId);
    console.log("[moveFile] ファイル取得成功", "fileName=" + file.getName());
    paperLog("[moveFile] ファイル取得成功", "fileName=" + file.getName());
    
    const currentParents = file.getParents();
    const targetFolderId = status === STATUS.approved ? CONFIG.okFolderId : CONFIG.ngFolderId;
    console.log("[moveFile] ターゲットフォルダID", "targetFolderId=" + targetFolderId);
    paperLog("[moveFile] ターゲットフォルダID", "targetFolderId=" + targetFolderId);
    
    const targetFolder = DriveApp.getFolderById(targetFolderId);
    console.log("[moveFile] ターゲットフォルダ取得成功", "folderName=" + targetFolder.getName());
    paperLog("[moveFile] ターゲットフォルダ取得成功", "folderName=" + targetFolder.getName());

    // 現在の親フォルダからファイルを削除
    while (currentParents.hasNext()) {
      const parent = currentParents.next();
      console.log("[moveFile] 親フォルダから削除", "parentId=" + parent.getId());
      parent.removeFile(file);
    }

    // ターゲットフォルダにファイルを追加
    targetFolder.addFile(file);
    console.log("[moveFile] ファイル移動完了", "fileId=" + fileId, "status=" + status);
    paperLog("[moveFile] ファイル移動完了", "fileId=" + fileId, "status=" + status);
  } catch (err) {
    console.error("[moveFile] エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
    paperLog("[moveFile] エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
    throw err;
  }
}

function buildJsonResponse(payload, status = 200) {
  const output = ContentService.createTextOutput(JSON.stringify({ ...payload, status }));
  output.setMimeType(ContentService.MimeType.JSON);
  applyCorsHeaders(output);
  return output;
}

function buildErrorResponse(message, status = 500) {
  return buildJsonResponse({ ok: false, error: message }, status);
}

function buildCorsResponse() {
  const output = ContentService.createTextOutput("");
  applyCorsHeaders(output);
  return output;
}

function applyCorsHeaders(output) {
  // Apps Script の TextOutput には setHeaders メソッドが存在しないため、
  // no-cors モードを使用しているため CORS ヘッダーは不要
  // エラーを防ぐために何もしない
  try {
    // 将来的にヘッダー設定が必要になった場合のためのプレースホルダー
    // output.setHeaders() は使用できない
  } catch (err) {
    console.warn("applyCorsHeaders: ヘッダー設定はスキップされました", err);
  }
}

// =========================
// サイネージ API（list/img64/image）
// =========================

// 署名シークレット（Script Properties 推奨）
function getSecret_() {
  const p = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  return p || 'TEMP_SECRET';
}

function signFor_(id, exp) {
  const data = `${id}.${exp}`;
  const bytes = Utilities.computeHmacSha256Signature(data, getSecret_());
  return Utilities.base64EncodeWebSafe(bytes);
}

function handleList_() {
  const folder = DriveApp.getFolderById(SIGNAGE_CONFIG.FOLDER_ID);
  const files = folder.getFiles();

  const items = [];
  while (files.hasNext()) {
    const f = files.next();
    const name = f.getName();
    const mime = f.getMimeType() || '';
    const isImage =
      mime.startsWith('image/') ||
      /heic|heif/i.test(mime) ||
      /\.(heic|heif|jpe?g|png|gif|webp|bmp|tiff?)$/i.test(name);
    if (!isImage) continue;

    const id = f.getId();
    const updated = f.getLastUpdated();
    const exp = Date.now() + SIGNAGE_CONFIG.EXPIRES_MS;
    const sig = signFor_(id, exp);
    const base = ScriptApp.getService().getUrl();
    const url  = `${base}?fn=img64&id=${encodeURIComponent(id)}&exp=${exp}&sig=${encodeURIComponent(sig)}`;

    items.push({
      id, name, mimeType: mime,
      updatedAt: updated.toISOString(),
      size: f.getSize(),
      url,
    });
  }
  items.sort((a,b)=> new Date(b.updatedAt) - new Date(a.updatedAt));

  return ContentService
    .createTextOutput(JSON.stringify({ now: new Date().toISOString(), count: items.length, items }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleImg64_(e) {
  const id = e.parameter.id;
  const exp = Number(e.parameter.exp || 0);
  const sig = e.parameter.sig;
  if (!id || !exp || !sig) return ContentService.createTextOutput(JSON.stringify({error:'Bad Request'})).setMimeType(ContentService.MimeType.JSON);
  if (Date.now() > exp)   return ContentService.createTextOutput(JSON.stringify({error:'Link expired'})).setMimeType(ContentService.MimeType.JSON);
  if (sig !== signFor_(id, exp)) return ContentService.createTextOutput(JSON.stringify({error:'Invalid signature'})).setMimeType(ContentService.MimeType.JSON);

  const blob = DriveApp.getFileById(id).getBlob();
  const mime = blob.getContentType() || 'application/octet-stream';
  const b64  = Utilities.base64Encode(blob.getBytes());

  return ContentService
    .createTextOutput(JSON.stringify({ mime, data: b64 }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleImage_(e) {
  const id = e.parameter.id;
  const exp = Number(e.parameter.exp || 0);
  const sig = e.parameter.sig;
  if (!id || !exp || !sig) return ContentService.createTextOutput('Bad Request');

  if (Date.now() > exp) return ContentService.createTextOutput('Link expired');
  if (sig !== signFor_(id, exp)) return ContentService.createTextOutput('Invalid signature');

  const file = DriveApp.getFileById(id);
  const blob = file.getBlob();
  return ContentService.createOutput(blob);
}

// （必要に応じてCORSヘッダを付けるバリアント）
function jsonResponse_(obj, status, extraHeaders) {
  const text = JSON.stringify(obj, null, 2);
  const out = ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  return addHeaders_(out, Object.assign({
    'Access-Control-Allow-Origin': SIGNAGE_CONFIG.ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  }, extraHeaders || {}), status);
}

function textResponse_(text, status) {
  const out = ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
  return addHeaders_(out, {
    'Access-Control-Allow-Origin': SIGNAGE_CONFIG.ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  }, status);
}

function addHeaders_(output, headers, status) {
  const resp = output;
  // Apps ScriptのContentServiceは任意ステータス設定APIがありません（＝常に200）。
  // ここでは可能な範囲でヘッダを付与します。
  if (headers) {
    const keys = Object.keys(headers);
    for (const k of keys) {
      resp.setHeader(k, String(headers[k]));
    }
  }
  return resp;
}
// =========================
// Slack Interactivity 処理
// =========================

function handleSlackInteractivity(event) {
  try {
    // 署名検証（開発時はスキップ）
    // if (CONFIG.slackSigningSecret && !verifySlackSignature(event)) {
    //   return ContentService.createTextOutput("invalid signature").setMimeType(ContentService.MimeType.TEXT);
    // }

    const payloadRaw = event.parameter.payload || "";
    if (!payloadRaw) {
      return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
    }

    const payload = JSON.parse(payloadRaw);

    if (payload.type === "block_actions") {
      const action = payload.actions[0];
      const userId = payload.user.id;
      const channel = payload.channel.id;
      const ts = payload.message.ts;
      const val = JSON.parse(action.value);

      if (action.action_id === "ok_move") {
        console.log("[handleSlackInteractivity] OK処理開始", "fileId=" + val.fileId, "fileName=" + val.name);
        paperLog("[handleSlackInteractivity] OK処理開始", "fileId=" + val.fileId, "fileName=" + val.name);
        
        try {
          // 処理開始を即時表示
          replaceOriginalViaResponseUrl(
            payload.response_url,
            payload.message.blocks,
            `⏳ 処理開始 by <@${userId}>`,
            false
          );

          // ファイルを OK フォルダへ移動
          console.log("[handleSlackInteractivity] moveFile呼び出し", "fileId=" + val.fileId);
          moveFile(val.fileId, STATUS.approved);

          // 完了メッセージ + ボタン無効化
          replaceOriginalViaResponseUrl(
            payload.response_url,
            payload.message.blocks,
            `✅ 承認済み by <@${userId}> → OKフォルダへ移動しました`,
            true
          );
          
          console.log("[handleSlackInteractivity] OK処理完了", "fileId=" + val.fileId);
          paperLog("[handleSlackInteractivity] OK処理完了", "fileId=" + val.fileId);
        } catch (err) {
          console.error("[handleSlackInteractivity] OK処理エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
          paperLog("[handleSlackInteractivity] OK処理エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
          
          replaceOriginalViaResponseUrl(
            payload.response_url,
            payload.message.blocks,
            `⚠️ OK処理エラー: ${escapeMrkdwn(String(err))}`,
            false
          );
        }
        return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
      }

      if (action.action_id === "ng_reason") {
        try {
          openNgModal(payload.trigger_id, val, channel, ts, payload.response_url, payload.message.blocks);
        } catch (err) {
          try {
            replaceOriginalViaResponseUrl(
              payload.response_url,
              payload.message.blocks,
              `⚠️ モーダル起動エラー: ${escapeMrkdwn(String(err))}`,
              false
            );
          } catch (_) {}
        }
        return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
      }
    }

    if (payload.type === "view_submission" && payload.view?.callback_id === "ng_modal") {
      const meta = JSON.parse(payload.view.private_metadata || "{}");
      const st = payload.view.state.values;
      const reasonSel = st.reason_block?.reason_select?.selected_option?.text?.text || "";
      const reasonText = st.reason_block2?.reason_text?.value || "";
      const reason = [reasonSel, reasonText].filter(Boolean).join(" / ") || "（未記入）";
      const userId = payload.user?.id || "unknown";

      try {
        console.log("[handleSlackInteractivity] NG処理開始", "fileId=" + meta.fileId, "reason=" + reason);
        paperLog("[handleSlackInteractivity] NG処理開始", "fileId=" + meta.fileId, "reason=" + reason);
        
        // 処理開始を即時表示
        replaceOriginalViaResponseUrl(meta.responseUrl, meta.blocks, `⏳ NG処理開始 by <@${userId}>`, false);

        // ファイルを NG フォルダへ移動
        console.log("[handleSlackInteractivity] moveFile呼び出し (NG)", "fileId=" + meta.fileId);
        moveFile(meta.fileId, STATUS.rejected);

        // 完了メッセージ + ボタン無効化
        replaceOriginalViaResponseUrl(
          meta.responseUrl,
          meta.blocks,
          `🛑 非承認（<@${userId}>：${escapeMrkdwn(reason)}） → NGフォルダへ移動しました`,
          true
        );
        
        console.log("[handleSlackInteractivity] NG処理完了", "fileId=" + meta.fileId);
        paperLog("[handleSlackInteractivity] NG処理完了", "fileId=" + meta.fileId);
      } catch (err) {
        console.error("[handleSlackInteractivity] NG処理エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
        paperLog("[handleSlackInteractivity] NG処理エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
        
        replaceOriginalViaResponseUrl(
          meta.responseUrl,
          meta.blocks,
          `⚠️ NG処理エラー: ${escapeMrkdwn(String(err))}`,
          false
        );
      }

      // モーダルを閉じる
      return ContentService.createTextOutput(JSON.stringify({ response_action: "clear" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    console.error("Slack Interactivity エラー:", err);
    return ContentService.createTextOutput("error").setMimeType(ContentService.MimeType.TEXT);
  }
}

function verifySlackSignature(event) {
  try {
    const sig = event.headers["X-Slack-Signature"] || event.headers["x-slack-signature"];
    const ts = event.headers["X-Slack-Request-Timestamp"] || event.headers["x-slack-request-timestamp"];
    if (!sig || !ts) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(ts)) > 60 * 5) return false;

    const body = event.postData?.contents || "";
    const base = `v0:${ts}:${body}`;
    const mac = Utilities.computeHmacSha256Signature(base, CONFIG.slackSigningSecret);
    const hex = mac.map((b) => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
    const expected = `v0=${hex}`;
    return sig === expected;
  } catch (_) {
    return false;
  }
}

function openNgModal(triggerId, val, channel, ts, responseUrl, baseBlocks) {
  const view = {
    type: "modal",
    callback_id: "ng_modal",
    title: { type: "plain_text", text: "NG理由" },
    submit: { type: "plain_text", text: "送信" },
    close: { type: "plain_text", text: "キャンセル" },
    private_metadata: JSON.stringify({
      fileId: val.fileId,
      name: val.name,
      channel,
      ts,
      responseUrl,
      blocks: baseBlocks,
    }),
    blocks: [
      {
        type: "input",
        block_id: "reason_block",
        label: { type: "plain_text", text: "NG理由（選択）" },
        element: {
          type: "static_select",
          action_id: "reason_select",
          placeholder: { type: "plain_text", text: "選択してください" },
          options: [
            { text: { type: "plain_text", text: "不適切な内容" }, value: "inappropriate" },
            { text: { type: "plain_text", text: "肖像権・著作権の懸念" }, value: "rights" },
            { text: { type: "plain_text", text: "画質/縦横比が基準外" }, value: "quality" },
            { text: { type: "plain_text", text: "重複アップロード" }, value: "duplicate" },
            { text: { type: "plain_text", text: "その他" }, value: "other" },
          ],
        },
      },
      {
        type: "input",
        block_id: "reason_block2",
        optional: true,
        label: { type: "plain_text", text: "補足（任意）" },
        element: {
          type: "plain_text_input",
          action_id: "reason_text",
          multiline: true,
          placeholder: { type: "plain_text", text: "詳細やメモを入力" },
        },
      },
    ],
  };

  const resp = UrlFetchApp.fetch("https://slack.com/api/views.open", {
    method: "post",
    headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
    payload: { trigger_id: triggerId, view: JSON.stringify(view) },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText() || "{}");
  if (!data.ok) {
    throw new Error("views.open failed: " + resp.getContentText());
  }
}

function replaceOriginalViaResponseUrl(responseUrl, baseBlocks, statusLine, removeActions) {
  let blocks = JSON.parse(JSON.stringify(baseBlocks || []));
  if (removeActions) {
    blocks = blocks.filter((b) => b.type !== "actions");
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: statusLine }] });

  const resp = UrlFetchApp.fetch(responseUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      replace_original: true,
      text: statusLine,
      blocks: blocks,
    }),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("response_url update failed: " + code + " " + resp.getContentText());
  }
}

function escapeMrkdwn(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// =========================
// ログ機能
// =========================

function paperLog() {
  // 引数を全部連結
  const msg = Array.from(arguments)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ");

  // 常に console.log で出力（Apps Script の実行ログで確認可能）
  console.log("[LOG]", new Date().toISOString(), msg);

  // スプレッドシートにも出力（設定されている場合）
  try {
    const sheetId = PropertiesService.getScriptProperties().getProperty("DEBUG_SHEET_ID");
    if (!sheetId) {
      // DEBUG_SHEET_ID が未設定ならスプレッドシートへの書き込みはスキップ
      return;
    }
    const ss = SpreadsheetApp.openById(sheetId);
    const sh = ss.getSheets()[0];

    // 見出しが無ければ作成
    if (sh.getLastRow() === 0) {
      sh.appendRow(["timestamp", "message"]);
    }

    sh.appendRow([new Date(), msg]);
  } catch (err) {
    // スプレッドシートへの書き込みに失敗しても無視（console.log は既に出力済み）
    console.warn("paperLog spreadsheet write failed:", err);
  }
}

