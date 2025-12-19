document.getElementById("extractAndCsv").addEventListener("click", async () => {
  console.log("=== START: Kliknięto przycisk ===");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab.id;
  console.log("Tab ID:", tabId);

  // Pobierz aktualny numer strony z interfejsu strony
  console.log("Pobieranie numeru strony...");
  const [{ result: startPage }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: getCurrentPageNumber
  });
  console.log("Strona startowa:", startPage);

  let page = startPage || 1;
  let allRows = []; // Tablica akumulująca wszystkie wiersze od początku

  while (true) {
    console.log(`\n--- Przetwarzanie strony ${page} ---`);
    
    // 1) Zbierz dane z AKTUALNEJ strony (z przewinięciem do końca)
    console.log(`Uruchamiam scraping strony ${page}...`);
    
    try {
      const [{ result: rows }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapeCurrentPageWithScroll
      });
      console.log(`Otrzymano ${rows?.length || 0} wierszy ze strony ${page}`);

      if (!rows || !rows.length) {
        console.log(`Strona ${page}: brak danych, przerywam.`);
        break;
      }

      // 2) Dodaj wiersze z tej strony do ogólnej tablicy
      allRows = allRows.concat(rows);
      console.log(`Strona ${page}: zebrano ${rows.length} wierszy (łącznie: ${allRows.length}).`);

      // 3) Generuj CSV ze WSZYSTKIMI danymi zebranymi do tej pory
      // Nazwa pliku: page_X (pierwsza iteracja) lub page_X-Y (kolejne)
      const fileName = page === startPage 
        ? `operations_page_${startPage}.csv`
        : `operations_page_${startPage}-${page}.csv`;
      
      console.log(`Zapisywanie pliku: ${fileName}`);
      downloadCsvWithName(allRows, fileName);

      // 4) Spróbuj przejść na następną stronę (z czekaniem na przeładowanie tabeli)
      console.log(`Próbuję przejść na stronę ${page + 1}...`);
      
      let hasNext;
      try {
        console.log(`[MAIN] Wywołuję executeScript dla goToNextPageAndWaitForChange...`);
        const result = await chrome.scripting.executeScript({
          target: { tabId },
          func: goToNextPageAndWaitForChange
        });
        console.log(`[MAIN] executeScript zakończył się, result:`, result);
        hasNext = result[0].result;
        console.log(`[MAIN] hasNext: ${hasNext}`);
      } catch (err) {
        console.error(`[MAIN] BŁĄD w executeScript:`, err);
        hasNext = false;
      }

      if (!hasNext) {
        console.log("Brak kolejnej strony – koniec.");
        break;
      }

      page++;
      console.log(`✓ Przeszedłem na stronę ${page}, zaczynam od nowa...`);
      
      // Małe opóźnienie przed kolejną iteracją
      await new Promise(r => setTimeout(r, 500));
      
    } catch (error) {
      console.error(`BŁĄD na stronie ${page}:`, error);
      break;
    }
  }

  const filesCount = page - startPage + 1;
  const message = `Zapisano ${filesCount} plików (strony ${startPage}-${page}), łącznie wierszy: ${allRows.length}`;
  console.log(`=== KONIEC: ${message} ===`);
  document.getElementById("output").textContent = message;
});

// ===============================
// CSV – po stronie popupu
// ===============================
function convertToCSV(data) {
  const Q = String.fromCharCode(34); // "
  const headers = Object.keys(data[0] || {});

  const escape = (value) =>
    Q + String(value ?? "").replace(/"/g, Q + Q) + Q;

  const rows = data.map((obj) =>
    headers.map((h) => escape(obj[h])).join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}

function downloadCsvWithName(rows, fileName) {
  console.log(`[DOWNLOAD] Tworzenie pliku ${fileName} z ${rows.length} wierszami...`);
  
  const csv = convertToCSV(rows);
  console.log(`[DOWNLOAD] CSV utworzony, rozmiar: ${csv.length} znaków`);
  
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  console.log(`[DOWNLOAD] Blob URL: ${url}`);

  chrome.downloads.download(
    {
      url,
      filename: fileName,
      saveAs: false
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(`[DOWNLOAD] BŁĄD: ${chrome.runtime.lastError.message}`);
      } else {
        console.log(`[DOWNLOAD] Pobieranie rozpoczęte, ID: ${downloadId}, plik: ${fileName}`);
      }
      // Czekamy chwilę przed zwolnieniem URL
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  );
}

// ===============================
// Kod wstrzykiwany w STRONĘ
// ===============================

// 0) Pobierz aktualny numer strony z interfejsu
function getCurrentPageNumber() {
  // Szukamy tekstu "Page X of Y" lub podobnego wzorca
  const pageInfo = document.querySelector('.MuiTablePagination-displayedRows');
  if (pageInfo) {
    const match = pageInfo.textContent.match(/(\d+)[-–]\d+\s+of\s+\d+/);
    if (match) {
      const startRow = parseInt(match[1]);
      // Zakładając 10 wierszy na stronę (dostosuj jeśli inaczej)
      const pageNum = Math.ceil(startRow / 10);
      return pageNum > 0 ? pageNum : 1;
    }
  }
  return 1; // domyślnie strona 1
}

// 1) Zbierz całą AKTUALNĄ stronę: poczekaj na tabelę, przewiń do końca, zwróć wiersze
function scrapeCurrentPageWithScroll() {
  return new Promise(async (resolve) => {
    console.log("[SCRAPE] Start scrapingu...");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function waitForTableReady() {
      return new Promise((res) => {
        const check = () => {
          const rows = document.querySelectorAll(".static-row");
          console.log(`[SCRAPE] Znaleziono ${rows.length} wierszy .static-row`);
          if (rows.length > 0) res();
          else setTimeout(check, 100);
        };
        check();
      });
    }

    await waitForTableReady();
    console.log("[SCRAPE] Tabela gotowa");

    const container = document.querySelector("div.data-table.MuiBox-root.css-o8lia2");
    if (!container) {
      console.log("[SCRAPE] Brak kontenera!");
      resolve([]);
      return;
    }
    console.log("[SCRAPE] Kontener znaleziony");

    // Przewiń na początek przed rozpoczęciem
    container.scrollTop = 0;
    await sleep(200);

    const collected = new Set();
    let lastCollectedCount = 0;
    let noChangeCount = 0;

    const collectVisibleRows = () => {
      const rows = [...container.querySelectorAll(".static-row")];
      rows.forEach((row) => collected.add(row.innerHTML));
      return rows.length;
    };

    // Zbierz początkowe wiersze
    collectVisibleRows();
    console.log(`[SCRAPE] Zebrano początkowe wiersze: ${collected.size}`);

    // Scrolluj aż do końca, zbierając wiersze po drodze
    while (true) {
      const currentScrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;
      
      console.log(`[SCRAPE] scrollTop: ${currentScrollTop}, scrollHeight: ${scrollHeight}, clientHeight: ${clientHeight}`);
      
      // Scrolluj w dół
      container.scrollTop += 500;
      await sleep(200);
      
      // Zbierz wiersze
      collectVisibleRows();
      console.log(`[SCRAPE] Zebrano ${collected.size} unikalnych wierszy`);
      
      // Sprawdź czy liczba wierszy się zmieniła
      if (collected.size === lastCollectedCount) {
        noChangeCount++;
        console.log(`[SCRAPE] Brak nowych wierszy (${noChangeCount}/3)`);
        
        // Jeśli przez 3 iteracje nie ma nowych wierszy, kończymy
        if (noChangeCount >= 3) {
          console.log(`[SCRAPE] Koniec scrollowania - brak nowych wierszy`);
          break;
        }
      } else {
        noChangeCount = 0;
        lastCollectedCount = collected.size;
      }
      
      // Sprawdź czy dotarliśmy na koniec kontenera
      if (container.scrollTop + clientHeight >= scrollHeight - 10) {
        console.log(`[SCRAPE] Dotarliśmy na koniec kontenera`);
        await sleep(300); // Dodatkowe czekanie na załadowanie
        collectVisibleRows();
        
        if (collected.size === lastCollectedCount) {
          console.log(`[SCRAPE] Koniec scrollowania - osiągnięto koniec`);
          break;
        }
        lastCollectedCount = collected.size;
      }
    }

    console.log(`[SCRAPE] Zebrano łącznie ${collected.size} unikalnych wierszy`);

    // Parsowanie HTML -> obiekty
    const parsed = [...collected].map((html) => {
      const div = document.createElement("div");
      div.innerHTML = html;

      const get = (id) =>
        div.querySelector(`.table-body-row-cell[data-id="${id}"]`)
          ?.innerText.trim() || "";

      const rawValue = get("value");
      let value = "";
      let currency = "";

      if (rawValue) {
        const parts = rawValue.split(" ").filter((p) => p.trim() !== "");
        if (parts.length >= 3) {
          value = parts[0] + parts[1]; // "+120" / "-50"
          currency = parts[2];         // "USD"
        }
      }

      return {
        date: get("operationDate"),
        type: get("type"),
        quantity: get("quantity"),
        asset: get("asset"),
        category: get("category"),
        value,
        currency
      };
    });

    console.log(`[SCRAPE] Sparsowano ${parsed.length} wierszy`);
    resolve(parsed);
  });
}

// 2) Przejdź na następną stronę i POCZEKAJ, aż tabela się zmieni
function goToNextPageAndWaitForChange() {
  return new Promise(async (resolve) => {
    console.log("[NEXT] Szukam przycisku następnej strony...");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const nextBtn = document.querySelector(
      'button[aria-label="Go to next page"]'
    );

    if (!nextBtn) {
      console.log("[NEXT] Przycisk nie istnieje");
      resolve(false);
      return;
    }

    if (nextBtn.disabled) {
      console.log("[NEXT] Przycisk jest wyłączony");
      resolve(false);
      return;
    }

    console.log("[NEXT] Przycisk znaleziony i aktywny");

    const hasRows = () => {
      const rows = document.querySelectorAll(".static-row");
      return rows.length > 0;
    };

    console.log("[NEXT] Wiersze przed kliknięciem: " + hasRows());
    
    nextBtn.click();
    console.log("[NEXT] Kliknięto przycisk - czekam na zniknięcie i pojawienie się wierszy...");

    let iteration = 0;
    let rowsDisappeared = false;
    
    // Czekamy cierpliwie aż wiersze znikną i pojawią się ponownie
    while (true) {
      await sleep(200);
      iteration++;
      
      const currentHasRows = hasRows();

      // Faza 1: Czekamy aż wiersze znikną (tabela się zaczyna ładować)
      if (!rowsDisappeared && !currentHasRows) {
        console.log(`[NEXT] ✓ Wiersze zniknęły - strona się ładuje (po ${iteration * 200}ms)`);
        rowsDisappeared = true;
      }
      
      // Faza 2: Po zniknięciu czekamy aż wiersze się pojawią (nowa strona gotowa)
      if (rowsDisappeared && currentHasRows) {
        console.log(`[NEXT] ✓ Wiersze się pojawiły - strona gotowa! (po ${iteration * 200}ms)`);
        
        // Dodatkowe czekanie żeby DOM się uspokoił i lazy loading zakończył
        await sleep(1000);
        console.log("[NEXT] Dodatkowe 1000ms na stabilizację DOM");
        
        resolve(true);
        return;
      }
      
      // Log co 5 sekund żeby wiedzieć że skrypt żyje
      if (iteration % 25 === 0) {
        const status = rowsDisappeared ? "czekam na pojawienie się wierszy" : "czekam na zniknięcie wierszy";
        console.log(`[NEXT] ${status}... (${iteration * 200}ms)`);
      }
    }
  });
}