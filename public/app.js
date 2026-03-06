const form = document.getElementById("search-form");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const assumptionsEl = document.getElementById("assumptions");
const sourcesEl = document.getElementById("sources");
const tableHead = document.querySelector("#result-table thead");
const tableBody = document.querySelector("#result-table tbody");
let emptyColspan = 1;

renderHeader([
  { key: "item", label: "Đối tượng", type: "text" },
  { key: "source_url", label: "Link", type: "url" },
  { key: "notes", label: "Ghi chú", type: "text" }
]);
renderEmpty("Nhập từ khóa để bắt đầu.");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const query = document.getElementById("query").value.trim();
  const targetSites = Number(document.getElementById("target-sites").value);
  const topK = 10;
  const engines = ["google", "bing"];

  if (!query) {
    updateStatus("Vui lòng nhập từ khóa.", true);
    return;
  }

  updateStatus("Đang thu thập và phân tích dữ liệu...");
  renderEmpty("Đang xử lý...");
  summaryEl.textContent = "Đang xử lý...";
  assumptionsEl.textContent = "";
  sourcesEl.innerHTML = "";

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query,
        target_sites: targetSites,
        top_k: topK,
        engines
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const message =
        data.error || `Request lỗi (HTTP ${res.status}). Vui lòng thử lại.`;
      throw new Error(message);
    }

    renderTable(data.table || []);
    renderSources(data.sources || []);

    summaryEl.textContent = [
      data.summary || "",
      `Đã quét ${data.collected_sites || 0}/${data.target_sites || 0} website từ ${(
        data.engines || []
      ).join(", ")}.`
    ]
      .filter(Boolean)
      .join(" ");

    const assumptions = Array.isArray(data.assumptions)
      ? data.assumptions.filter(Boolean)
      : [];
    assumptionsEl.textContent =
      assumptions.length > 0
        ? `Lưu ý: ${assumptions.join(" | ")}`
        : "Lưu ý: Nên kiểm tra lại số liệu trên website chính thức.";

    updateStatus("Hoàn tất.");
  } catch (error) {
    renderEmpty("Không lấy được kết quả.");
    summaryEl.textContent = "Có lỗi khi gọi API.";
    assumptionsEl.textContent = "";
    updateStatus(
      error && error.message ? error.message : "Có lỗi chưa xác định.",
      true
    );
  }
});

function renderTable(rows) {
  const table = normalizeTablePayload(rows);
  const columns = table.columns;
  const dataRows = table.rows;

  renderHeader(columns);

  if (!Array.isArray(dataRows) || dataRows.length === 0) {
    renderEmpty("Không có dòng dữ liệu phù hợp.");
    return;
  }

  tableBody.innerHTML = dataRows
    .map((row, idx) => {
      const cells = columns
        .map((col) => {
          const raw = pickCellValue(row, col);
          const value = escapeHtml(raw);
          if (col.type === "url" && raw) {
            return `<td><a href="${value}" target="_blank" rel="noopener noreferrer">Mở nguồn</a></td>`;
          }
          return `<td>${value || ""}</td>`;
        })
        .join("");

      return `<tr><td>${idx + 1}</td>${cells}</tr>`;
    })
    .join("");
}

function renderSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    sourcesEl.innerHTML = "<li>Không có nguồn.</li>";
    return;
  }
  sourcesEl.innerHTML = sources
    .map(
      (src) =>
        `<li><span class="engine">${escapeHtml(src.engine || "")}</span> <a href="${
          src.url
        }" target="_blank" rel="noopener noreferrer">${escapeHtml(
          src.title || src.url || ""
        )}</a></li>`
    )
    .join("");
}

function renderEmpty(message) {
  tableBody.innerHTML = `<tr><td colspan="${emptyColspan}" class="empty">${escapeHtml(
    message
  )}</td></tr>`;
}

function renderHeader(columns) {
  const heads = columns
    .map((col) => `<th>${escapeHtml(col.label || col.key || "Cột")}</th>`)
    .join("");
  tableHead.innerHTML = `<tr><th>#</th>${heads}</tr>`;
  emptyColspan = columns.length + 1;
}

function normalizeTablePayload(payload) {
  if (Array.isArray(payload)) {
    // Backward compatibility for old response format.
    const columns = [
      { key: "name", label: "Tên", type: "text" },
      { key: "address", label: "Địa chỉ", type: "text" },
      { key: "tuition", label: "Học phí", type: "text" },
      { key: "source_url", label: "Link", type: "url" },
      { key: "notes", label: "Ghi chú", type: "text" }
    ];
    return { columns, rows: payload };
  }

  const candidateColumns = Array.isArray(payload?.columns) ? payload.columns : [];
  const candidateRows = Array.isArray(payload?.rows) ? payload.rows : [];
  const columns = normalizeColumns(candidateColumns);
  return { columns, rows: candidateRows };
}

function normalizeColumns(columns) {
  const cleaned = [];
  const used = new Set();

  for (const col of columns) {
    if (!col || typeof col !== "object") continue;
    const key = toKey(col.key || col.label);
    if (!key || used.has(key)) continue;
    used.add(key);

    const label = String(col.label || key).trim();
    let type = String(col.type || "").trim().toLowerCase();
    if (type !== "url") type = isUrlKey(key, label) ? "url" : "text";

    cleaned.push({ key, label, type });
  }

  if (cleaned.length === 0) {
    cleaned.push(
      { key: "item", label: "Đối tượng", type: "text" },
      { key: "source_url", label: "Link", type: "url" },
      { key: "notes", label: "Ghi chú", type: "text" }
    );
  }

  if (!cleaned.some((c) => c.type === "url")) {
    cleaned.push({ key: "source_url", label: "Link", type: "url" });
  }
  if (!cleaned.some((c) => /note|ghi/.test(`${c.key} ${c.label}`.toLowerCase()))) {
    cleaned.push({ key: "notes", label: "Ghi chú", type: "text" });
  }

  return cleaned;
}

function pickCellValue(row, col) {
  if (!row || typeof row !== "object") return "";
  const keyValue = row[col.key];
  if (keyValue != null) return String(keyValue).trim();

  const labelValue = row[col.label];
  if (labelValue != null) return String(labelValue).trim();

  if (col.type === "url") {
    const url = row.source_url ?? row.link ?? row.url;
    return url != null ? String(url).trim() : "";
  }

  return "";
}

function toKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isUrlKey(key, label) {
  const t = `${key} ${label}`.toLowerCase();
  return t.includes("url") || t.includes("link");
}

function updateStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
