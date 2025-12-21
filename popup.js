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
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  );
}

// ===============================
// GŁÓWNY EVENT LISTENER
// ===============================
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

  // Pobierz tekst z pierwszego <p class="css-1q91ocd">
  console.log("Pobieranie tekstu z css-1q91ocd...");
  const [{ result: prefixText }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const elem = document.querySelector('p.css-1q91ocd');
      return elem ? elem.textContent.trim() : '';
    }
  });
  console.log("Prefix z css-1q91ocd:", prefixText);

  let page = startPage || 1;
  const filePrefix = prefixText ? `${prefixText}_` : '';
  
  let allRows = []; // Akumulator danych
  let batchStartPage = startPage; // Początek aktualnej paczki
  const MAX_PAGES_PER_FILE = 10;

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

      // 2) Dodaj wiersze do akumulatora
      allRows = allRows.concat(rows);
      console.log(`Dodano ${rows.length} wierszy, łącznie w pamięci: ${allRows.length}`);

      // 3) Sprawdź czy mamy już 10 stron w paczce
      const pagesInBatch = page - batchStartPage + 1;
      
      if (pagesInBatch >= MAX_PAGES_PER_FILE) {
        // Zapisz plik z aktualną paczką
        const fileName = batchStartPage === page 
          ? `${filePrefix}operations_page_${batchStartPage}.csv`
          : `${filePrefix}operations_page_${batchStartPage}-${page}.csv`;
        
        console.log(`=== Zapisywanie paczki: ${fileName} (${allRows.length} wierszy) ===`);
        downloadCsvWithName(allRows, fileName);
        
        // Wyczyść pamięć
        allRows = [];
        batchStartPage = page + 1;
        console.log(`Wyczyszczono pamięć, następna paczka od strony ${batchStartPage}`);
      }

      // 4) Spróbuj przejść na następną stronę
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
        console.log("Brak kolejnej strony – zapisuję ostatnią paczkę i kończę.");
        
        // Zapisz pozostałe dane jeśli są
        if (allRows.length > 0) {
          const fileName = batchStartPage === page 
            ? `${filePrefix}operations_page_${batchStartPage}.csv`
            : `${filePrefix}operations_page_${batchStartPage}-${page}.csv`;
          
          console.log(`=== Zapisywanie ostatniej paczki: ${fileName} (${allRows.length} wierszy) ===`);
          downloadCsvWithName(allRows, fileName);
        }
        
        break;
      }

      page++;
      console.log(`✓ Przeszedłem na stronę ${page}, kontynuuję...`);
      
      // Małe opóźnienie przed kolejną iteracją
      await new Promise(r => setTimeout(r, 500));
      
    } catch (error) {
      console.error(`BŁĄD na stronie ${page}:`, error);
      
      // Zapisz to co mamy przed przerwaniem
      if (allRows.length > 0) {
        const fileName = batchStartPage === page 
          ? `${filePrefix}operations_page_${batchStartPage}.csv`
          : `${filePrefix}operations_page_${batchStartPage}-${page}.csv`;
        
        console.log(`=== BŁĄD: Zapisywanie awaryjne: ${fileName} (${allRows.length} wierszy) ===`);
        downloadCsvWithName(allRows, fileName);
      }
      
      break;
    }
  }

  const totalPages = page - startPage + 1;
  const message = `Zakończono. Przetworzone strony: ${startPage}-${page} (${totalPages} stron)`;
  console.log(`=== KONIEC: ${message} ===`);
  document.getElementById("output").textContent = message;
});

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

    // Przewiń na sam początek
    container.scrollTop = 0;
    await sleep(500);
    console.log("[SCRAPE] Start od góry");

    // Zbieramy wiersze po data-index
    const collectedByIndex = new Map();
    
    let lastScrollTop = -1;
    let scrollCount = 0;
    let noNewCount = 0;
    
    // Przewijaj w dół i zbieraj wiersze
    while (scrollCount < 100) {
      const previousSize = collectedByIndex.size;
      
      // Zbierz aktualne wiersze
      const currentRows = [...document.querySelectorAll(".static-row")];
      
      currentRows.forEach((row) => {
        const dataIndex = row.getAttribute('data-index');
        
        if (dataIndex && !collectedByIndex.has(dataIndex)) {
          const get = (id) =>
            row.querySelector(`.table-body-row-cell[data-id="${id}"]`)
              ?.innerText.trim() || "";

          const rawValue = get("value");
          let value = "";
          let currency = "";
          let value2 = "";
          let currency2 = "";

          if (rawValue) {
            // Sprawdź czy jest konwersja (->)
            if (rawValue.includes("->")) {
              const conversionParts = rawValue.split("->").map(p => p.trim());
              
              // Pierwsza część (value + currency)
              if (conversionParts[0]) {
                const parts1 = conversionParts[0].split(" ").filter((p) => p.trim() !== "");
                if (parts1.length >= 2) {
                  value = parts1.slice(0, -1).join(" "); // wszystko oprócz ostatniego
                  currency = parts1[parts1.length - 1]; // ostatni to waluta
                }
              }
              
              // Druga część (value2 + currency2)
              if (conversionParts[1]) {
                const parts2 = conversionParts[1].split(" ").filter((p) => p.trim() !== "");
                if (parts2.length >= 2) {
                  value2 = parts2.slice(0, -1).join(" ");
                  currency2 = parts2[parts2.length - 1];
                }
              }
            } else {
              // Brak konwersji - normalnie parsuj
              const parts = rawValue.split(" ").filter((p) => p.trim() !== "");
              if (parts.length >= 2) {
                value = parts.slice(0, -1).join(" ");
                currency = parts[parts.length - 1];
              }
            }
          }

          collectedByIndex.set(dataIndex, {
            date: get("operationDate"),
            type: get("type"),
            quantity: get("quantity"),
            asset: get("asset"),
            category: get("category"),
            value,
            currency,
            value2,
            currency2
          });
        }
      });
      
      const newAdded = collectedByIndex.size - previousSize;
      console.log(`[SCRAPE] Scroll ${scrollCount}: zebrano ${collectedByIndex.size} wierszy (+${newAdded}), widocznych: ${currentRows.length}`);
      
      const currentScrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;
      
      // Jeśli nie ma nowych wierszy
      if (newAdded === 0) {
        noNewCount++;
        if (noNewCount >= 5) {
          console.log(`[SCRAPE] Brak nowych wierszy przez 5 iteracji, kończymy`);
          break;
        }
      } else {
        noNewCount = 0;
      }
      
      // Sprawdź czy jesteśmy na końcu
      if (currentScrollTop + clientHeight >= scrollHeight - 5) {
        console.log(`[SCRAPE] Osiągnięto koniec kontenera`);
        await sleep(500);
        // Zbierz jeszcze raz
        const finalRows = [...document.querySelectorAll(".static-row")];
        finalRows.forEach((row) => {
          const dataIndex = row.getAttribute('data-index');
          if (dataIndex && !collectedByIndex.has(dataIndex)) {
            const get = (id) =>
              row.querySelector(`.table-body-row-cell[data-id="${id}"]`)
                ?.innerText.trim() || "";
            
            const rawValue = get("value");
            let value = "", currency = "", value2 = "", currency2 = "";
            
            if (rawValue) {
              if (rawValue.includes("->")) {
                const conversionParts = rawValue.split("->").map(p => p.trim());
                if (conversionParts[0]) {
                  const parts1 = conversionParts[0].split(" ").filter((p) => p.trim() !== "");
                  if (parts1.length >= 2) {
                    value = parts1.slice(0, -1).join(" ");
                    currency = parts1[parts1.length - 1];
                  }
                }
                if (conversionParts[1]) {
                  const parts2 = conversionParts[1].split(" ").filter((p) => p.trim() !== "");
                  if (parts2.length >= 2) {
                    value2 = parts2.slice(0, -1).join(" ");
                    currency2 = parts2[parts2.length - 1];
                  }
                }
              } else {
                const parts = rawValue.split(" ").filter((p) => p.trim() !== "");
                if (parts.length >= 2) {
                  value = parts.slice(0, -1).join(" ");
                  currency = parts[parts.length - 1];
                }
              }
            }
            
            collectedByIndex.set(dataIndex, {
              date: get("operationDate"),
              type: get("type"),
              quantity: get("quantity"),
              asset: get("asset"),
              category: get("category"),
              value,
              currency,
              value2,
              currency2
            });
          }
        });
        console.log(`[SCRAPE] Finalne zbieranie: ${collectedByIndex.size} wierszy`);
        break;
      }
      
      // Sprawdź czy scroll się nie rusza
      if (currentScrollTop === lastScrollTop && scrollCount > 2) {
        console.log(`[SCRAPE] Scroll się nie rusza`);
        break;
      }
      
      lastScrollTop = currentScrollTop;
      container.scrollTop += 200;
      await sleep(350);
      scrollCount++;
    }
    
    const parsed = [...collectedByIndex.values()];
    console.log(`[SCRAPE] *** FINAL: Sparsowano ${parsed.length} wierszy ***`);
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