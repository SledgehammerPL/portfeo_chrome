let lastExtracted = []; // przechowujemy wynik, żeby móc zapisać CSV

document.getElementById("extract").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractOperationsFromDOM
  });

  lastExtracted = result[0].result;

  document.getElementById("output").textContent =
    JSON.stringify(lastExtracted, null, 2);
});

document.getElementById("downloadCsv").addEventListener("click", () => {
  if (!lastExtracted.length) {
    alert("Najpierw pobierz dane!");
    return;
  }

  const csv = convertToCSV(lastExtracted);

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename: "operations.csv"
  });
});

// ----------------------------
// Funkcja wykonywana w DOM strony
// ----------------------------
function extractOperationsFromDOM() {
  const rows = [...document.querySelectorAll(".static-row")];

  return rows.map(row => {
    const get = id =>
      row.querySelector(`.table-body-row-cell[data-id="${id}"]`)?.innerText.trim() || "";

    return {
      date: get("operationDate"),
      type: get("type"),
      quantity: get("quantity"),
      asset: get("asset"),
      category: get("category"),
      value: get("value")
    };
  });
}

// ----------------------------
// Konwersja do CSV
// ----------------------------
function convertToCSV(data) {
  const Q = String.fromCharCode(34); // znak "
  const headers = Object.keys(data[0]);

  const escape = value =>
    Q + String(value).replace(/"/g, Q + Q) + Q;

  const rows = data.map(obj =>
    headers.map(h => escape(obj[h])).join(",")
  );

  return "\uFEFF" + [headers.join(","), ...rows].join("\n");

}

