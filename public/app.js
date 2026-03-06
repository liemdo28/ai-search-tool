const form = document.getElementById("search-form");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const assumptionsEl = document.getElementById("assumptions");
const sourcesEl = document.getElementById("sources");
const tableBody = document.querySelector("#result-table tbody");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const query = document.getElementById("query").value.trim();
  const targetSites = Number(document.getElementById("target-sites").value);
  const topK = Number(document.getElementById("top-k").value);
  const engines = Array.from(
    document.querySelectorAll('.chip input[type="checkbox"]:checked')
  ).map((node) => node.value);

  if (!query) {
    updateStatus("Vui lòng nhập từ khóa.", true);
    return;
  }

  if (engines.length === 0) {
    updateStatus("Cần chọn ít nhất 1 search engine.", true);
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
        : "Lưu ý: Nên kiểm tra lại các con số học phí trên trang chính thức.";

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
  if (!Array.isArray(rows) || rows.length === 0) {
    renderEmpty("Không có dòng dữ liệu phù hợp.");
    return;
  }

  tableBody.innerHTML = rows
    .map((row) => {
      const url = escapeHtml(row.source_url || "");
      return `
      <tr>
        <td>${escapeHtml(String(row.rank ?? ""))}</td>
        <td>${escapeHtml(row.name || "")}</td>
        <td>${escapeHtml(row.address || "")}</td>
        <td>${escapeHtml(row.tuition || "")}</td>
        <td>${
          url
            ? `<a href="${url}" target="_blank" rel="noopener noreferrer">Mở</a>`
            : ""
        }</td>
        <td>${escapeHtml(row.notes || "")}</td>
      </tr>
    `;
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
  tableBody.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(
    message
  )}</td></tr>`;
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

