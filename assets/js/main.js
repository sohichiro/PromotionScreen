const form = document.getElementById("upload-form");
const photoInput = document.getElementById("photo-input");
const commentInput = document.getElementById("comment-input");
const emailInput = document.getElementById("email-input");
const permissionCheckbox = document.getElementById("permission-checkbox");
const submitButton = document.getElementById("submit-button");
const preview = document.getElementById("preview");
const previewImage = document.getElementById("preview-image");
const statusContainer = document.getElementById("status");
const statusTemplate = document.getElementById("status-template");
const currentYear = document.getElementById("current-year");

const MAX_FILE_SIZE_MB = 8;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

currentYear.textContent = new Date().getFullYear().toString();

const buildStatusMessage = ({ status, message, details = "" }) => {
  const node = statusTemplate.content.cloneNode(true);
  node.querySelector("[data-status]").dataset.status = status;
  node.querySelector("[data-message]").textContent = message;
  node.querySelector("[data-details]").textContent = details;
  return node;
};

const setStatus = ({ status, message, details }) => {
  statusContainer.replaceChildren(buildStatusMessage({ status, message, details }));
};

const clearStatus = () => {
  statusContainer.textContent = "";
};

const validateFile = (file) => {
  if (!file) return "ファイルが選択されていません。";

  if (!ACCEPTED_TYPES.includes(file.type)) {
    return "jpg / png / webp / heic の画像ファイルのみアップロードできます。";
  }

  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_FILE_SIZE_MB) {
    return `ファイルサイズは最大 ${MAX_FILE_SIZE_MB}MB までです。`;
  }

  return null;
};

const updatePreview = () => {
  const [file] = photoInput.files;
  if (!file) {
    preview.classList.remove("preview--has-image");
    previewImage.src = "";
    previewImage.alt = "";
    return;
  }

  const error = validateFile(file);
  if (error) {
    setStatus({ status: "error", message: "画像を確認してください", details: error });
    photoInput.value = "";
    preview.classList.remove("preview--has-image");
    previewImage.src = "";
    previewImage.alt = "";
    checkFormState();
    return;
  }

  clearStatus();
  const reader = new FileReader();
  reader.onload = () => {
    previewImage.src = reader.result;
    previewImage.alt = "選択された画像のプレビュー";
    preview.classList.add("preview--has-image");
  };
  reader.readAsDataURL(file);
};

const checkFormState = () => {
  const hasFile = photoInput.files.length > 0;
  submitButton.disabled = !(hasFile && permissionCheckbox.checked);
};

const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const submitPhoto = async () => {
  const endpoint = window.UPLOAD_ENDPOINT;

  if (!endpoint || endpoint.includes("DEPLOY_ID")) {
    throw new Error("アップロード先のエンドポイントが設定されていません。");
  }

  const [file] = photoInput.files;
  const base64 = await toBase64(file);
  const email = emailInput.value.trim();
  const payload = {
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    comment: commentInput.value.trim(),
    email: email || undefined, // 空文字列の場合はundefinedにして送信しない
    timestamp: new Date().toISOString(),
    photoBase64: base64,
  };

  await fetch(endpoint, {
    method: "POST",
    mode: "no-cors",
    body: JSON.stringify(payload),
  });

  return {};
};

photoInput.addEventListener("change", () => {
  updatePreview();
  checkFormState();
});

permissionCheckbox.addEventListener("change", checkFormState);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const [file] = photoInput.files;
  const error = validateFile(file);
  if (error) {
    setStatus({ status: "error", message: "送信できません", details: error });
    return;
  }

  submitButton.disabled = true;
  setStatus({ status: "loading", message: "アップロード中…", details: "通信が完了するまでこのままお待ちください。" });

  try {
    await submitPhoto();
    setStatus({
      status: "success",
      message: "送信が完了しました！",
      details: "ご協力ありがとうございます。",
    });
    form.reset();
    preview.classList.remove("preview--has-image");
    previewImage.src = "";
    previewImage.alt = "";
    checkFormState();
  } catch (err) {
    console.error(err);
    setStatus({
      status: "error",
      message: "送信に失敗しました",
      details: err.message || "時間をおいて再度お試しください。",
    });
    checkFormState();
  }
});

