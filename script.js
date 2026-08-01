(function () {
  "use strict";

  // pdf.js needs to know where its worker script lives.
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  // ---------- state ----------
  /** @type {{id: string, file: File, numPages: number|null}[]} */
  var items = [];
  var idCounter = 0;
  var mergedBytes = null;

  // ---------- dom refs ----------
  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var fileError = document.getElementById("fileError");
  var stepOrder = document.getElementById("step-order");
  var stepMerge = document.getElementById("step-merge");
  var fileList = document.getElementById("fileList");
  var mergeBtn = document.getElementById("mergeBtn");
  var outputNameInput = document.getElementById("outputName");
  var mergeResult = document.getElementById("mergeResult");
  var mergeSummary = document.getElementById("mergeSummary");
  var downloadBtn = document.getElementById("downloadBtn");
  var resetBtn = document.getElementById("resetBtn");
  var statusRegion = document.getElementById("statusRegion");
  var loadingOverlay = document.getElementById("loadingOverlay");
  var loadingText = document.getElementById("loadingText");
  var stapleIcon = document.getElementById("stapleIcon");

  // ---------- helpers ----------
  function announce(msg) {
    statusRegion.textContent = msg;
  }

  function showError(msg) {
    fileError.textContent = msg;
    fileError.hidden = false;
  }

  function clearError() {
    fileError.hidden = true;
    fileError.textContent = "";
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function isPdfFile(file) {
    var name = (file.name || "").toLowerCase();
    return file.type === "application/pdf" || name.endsWith(".pdf");
  }

  function sanitizeFileName(name) {
    var cleaned = name.replace(/[^a-z0-9-_ ]/gi, "").trim();
    return cleaned.length ? cleaned : "merged";
  }

  // ---------- file intake ----------
  function addFiles(fileListLike) {
    var incoming = Array.prototype.slice.call(fileListLike);
    if (!incoming.length) return;

    var rejected = [];
    var accepted = [];

    incoming.forEach(function (file) {
      if (isPdfFile(file)) {
        accepted.push(file);
      } else {
        rejected.push(file.name);
      }
    });

    if (rejected.length) {
      showError(
        "Skipped " +
          rejected.length +
          (rejected.length === 1 ? " file" : " files") +
          " that " +
          (rejected.length === 1 ? "isn't" : "aren't") +
          " a PDF: " +
          rejected.join(", ")
      );
    } else {
      clearError();
    }

    accepted.forEach(function (file) {
      var id = "f" + ++idCounter;
      items.push({ id: id, file: file, numPages: null });
      renderFileItem(id, file);
    });

    updateStepVisibility();
    updateMergeButtonState();
    announce(
      items.length + (items.length === 1 ? " file added." : " files added.")
    );

    // reset merge output if the file set changes after a merge already happened
    resetMergeResult();
  }

  // ---------- rendering the file list ----------
  function renderFileItem(id, file) {
    var li = document.createElement("li");
    li.className = "file-item";
    li.draggable = true;
    li.dataset.id = id;
    li.setAttribute("aria-label", file.name);

    var thumb = document.createElement("div");
    thumb.className = "file-thumb";
    var placeholder = document.createElement("span");
    placeholder.className = "file-thumb-placeholder";
    placeholder.textContent = "PDF";
    thumb.appendChild(placeholder);

    var meta = document.createElement("div");
    meta.className = "file-meta";
    var nameEl = document.createElement("div");
    nameEl.className = "file-name";
    nameEl.textContent = file.name;
    var subEl = document.createElement("div");
    subEl.className = "file-sub";
    subEl.textContent = formatSize(file.size) + " · loading pages\u2026";
    meta.appendChild(nameEl);
    meta.appendChild(subEl);

    var actions = document.createElement("div");
    actions.className = "file-actions";

    var upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "btn-icon move-up";
    upBtn.setAttribute("aria-label", "Move up");
    upBtn.textContent = "\u2191";
    upBtn.addEventListener("click", function () {
      moveItem(id, -1);
    });

    var downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "btn-icon move-down";
    downBtn.setAttribute("aria-label", "Move down");
    downBtn.textContent = "\u2193";
    downBtn.addEventListener("click", function () {
      moveItem(id, 1);
    });

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-icon remove";
    removeBtn.setAttribute("aria-label", "Remove " + file.name);
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", function () {
      removeItem(id);
    });

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    actions.appendChild(removeBtn);

    li.appendChild(thumb);
    li.appendChild(meta);
    li.appendChild(actions);
    fileList.appendChild(li);

    attachDragHandlers(li);
    renderThumbnail(file, thumb, subEl, id);
    updateMoveButtonStates();
  }

  function renderThumbnail(file, thumbEl, subEl, id) {
    if (!window.pdfjsLib) return;

    file
      .arrayBuffer()
      .then(function (buffer) {
        return window.pdfjsLib.getDocument({ data: buffer }).promise;
      })
      .then(function (pdf) {
        var item = items.find(function (it) {
          return it.id === id;
        });
        if (item) item.numPages = pdf.numPages;
        subEl.textContent =
          formatSize(file.size) +
          " · " +
          pdf.numPages +
          (pdf.numPages === 1 ? " page" : " pages");

        return pdf.getPage(1).then(function (page) {
          var viewport = page.getViewport({ scale: 0.4 });
          var canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          var ctx = canvas.getContext("2d");
          return page
            .render({ canvasContext: ctx, viewport: viewport })
            .promise.then(function () {
              thumbEl.innerHTML = "";
              thumbEl.appendChild(canvas);
            });
        });
      })
      .catch(function () {
        subEl.textContent = formatSize(file.size) + " · couldn't preview this one";
      });
  }

  // ---------- reordering ----------
  function getIndexById(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return i;
    }
    return -1;
  }

  function moveItem(id, delta) {
    var from = getIndexById(id);
    if (from === -1) return;
    var to = from + delta;
    if (to < 0 || to >= items.length) return;
    var moved = items.splice(from, 1)[0];
    items.splice(to, 0, moved);
    reorderDom();
    resetMergeResult();
    announce("Moved " + moved.file.name + (delta < 0 ? " up." : " down."));
  }

  function reorderDom() {
    items.forEach(function (item) {
      var li = fileList.querySelector('[data-id="' + item.id + '"]');
      if (li) fileList.appendChild(li);
    });
    updateMoveButtonStates();
  }

  function updateMoveButtonStates() {
    items.forEach(function (item, index) {
      var li = fileList.querySelector('[data-id="' + item.id + '"]');
      if (!li) return;
      var up = li.querySelector(".move-up");
      var down = li.querySelector(".move-down");
      if (up) up.disabled = index === 0;
      if (down) down.disabled = index === items.length - 1;
    });
  }

  function removeItem(id) {
    var index = getIndexById(id);
    if (index === -1) return;
    var removedName = items[index].file.name;
    items.splice(index, 1);
    var li = fileList.querySelector('[data-id="' + id + '"]');
    if (li) li.remove();
    updateStepVisibility();
    updateMergeButtonState();
    updateMoveButtonStates();
    resetMergeResult();
    announce("Removed " + removedName + ".");
  }

  var dragSourceId = null;

  function attachDragHandlers(li) {
    li.addEventListener("dragstart", function () {
      dragSourceId = li.dataset.id;
      li.classList.add("dragging");
    });

    li.addEventListener("dragend", function () {
      li.classList.remove("dragging");
      dragSourceId = null;
      Array.prototype.forEach.call(
        fileList.querySelectorAll(".file-item"),
        function (el) {
          el.classList.remove("drop-target");
        }
      );
    });

    li.addEventListener("dragover", function (e) {
      e.preventDefault();
      if (li.dataset.id !== dragSourceId) {
        li.classList.add("drop-target");
      }
    });

    li.addEventListener("dragleave", function () {
      li.classList.remove("drop-target");
    });

    li.addEventListener("drop", function (e) {
      e.preventDefault();
      li.classList.remove("drop-target");
      var targetId = li.dataset.id;
      if (!dragSourceId || dragSourceId === targetId) return;

      var fromIndex = getIndexById(dragSourceId);
      var toIndex = getIndexById(targetId);
      if (fromIndex === -1 || toIndex === -1) return;

      var moved = items.splice(fromIndex, 1)[0];
      items.splice(toIndex, 0, moved);
      reorderDom();
      resetMergeResult();
      announce("Moved " + moved.file.name + " in the order.");
    });
  }

  // ---------- step / button visibility ----------
  function updateStepVisibility() {
    stepOrder.hidden = items.length === 0;
    stepMerge.hidden = items.length === 0;
  }

  function updateMergeButtonState() {
    mergeBtn.disabled = items.length < 2;
    mergeBtn.textContent =
      items.length < 2 ? "Add at least 2 files to merge" : "Merge PDFs";
  }

  function resetMergeResult() {
    mergedBytes = null;
    mergeResult.hidden = true;
  }

  // ---------- merging ----------
  function mergePdfs() {
    if (!window.PDFLib || items.length < 2) return;

    mergeBtn.disabled = true;
    mergeBtn.textContent = "Merging\u2026";
    clearError();

    var PDFDocument = window.PDFLib.PDFDocument;
    var mergedPdf;

    PDFDocument.create()
      .then(function (doc) {
        mergedPdf = doc;
        var chain = Promise.resolve();
        var failed = [];

        items.forEach(function (item) {
          chain = chain
            .then(function () {
              return item.file.arrayBuffer();
            })
            .then(function (bytes) {
              return PDFDocument.load(bytes);
            })
            .then(function (srcDoc) {
              return mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
            })
            .then(function (copiedPages) {
              copiedPages.forEach(function (page) {
                mergedPdf.addPage(page);
              });
            })
            .catch(function () {
              failed.push(item.file.name);
            });
        });

        return chain.then(function () {
          return { failed: failed };
        });
      })
      .then(function (result) {
        if (mergedPdf.getPageCount() === 0) {
          throw new Error("none-readable");
        }
        if (result.failed.length) {
          showError(
            "Couldn't read " +
              result.failed.join(", ") +
              " — it may be encrypted or corrupted. The rest were merged; remove that file and try again if you need it included."
          );
        }
        return mergedPdf.save();
      })
      .then(function (bytes) {
        mergedBytes = bytes;
        var pageCount = mergedPdf.getPageCount();
        mergeSummary.textContent =
          items.length +
          " files \u2192 " +
          pageCount +
          (pageCount === 1 ? " page" : " pages") +
          " merged into one file.";
        mergeResult.hidden = false;
        announce(
          "Merged " + items.length + " files into " + pageCount + " pages."
        );
      })
      .catch(function () {
        showError(
          "Couldn't merge those files — one or more PDFs may be encrypted or corrupted. Remove the problem file and try again."
        );
      })
      .finally(function () {
        mergeBtn.disabled = items.length < 2;
        updateMergeButtonState();
      });
  }

  // ---------- download ----------
  function downloadMerged() {
    if (!mergedBytes) return;

    downloadBtn.disabled = true;
    loadingText.textContent = "Stapling your pages together\u2026";
    loadingOverlay.hidden = false;

    window.setTimeout(function () {
      loadingOverlay.hidden = true;
      downloadBtn.disabled = false;

      var name = sanitizeFileName(outputNameInput.value || "merged") + ".pdf";
      var blob = new Blob([mergedBytes], { type: "application/pdf" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);

      if (stapleIcon) {
        stapleIcon.classList.remove("snap");
        // restart the animation
        window.requestAnimationFrame(function () {
          stapleIcon.classList.add("snap");
        });
      }

      mergeSummary.textContent =
        "\ud83c\udf89 Your PDF is merged — " + name + " is downloading.";
      announce("Your PDF is merged. " + name + " is downloading now.");
    }, 1300);
  }

  // ---------- reset ----------
  function resetAll() {
    items = [];
    mergedBytes = null;
    fileList.innerHTML = "";
    mergeResult.hidden = true;
    clearError();
    outputNameInput.value = "merged";
    updateStepVisibility();
    updateMergeButtonState();
    announce("Cleared. Add files to start a new merge.");
  }

  // ---------- event wiring ----------
  dropzone.addEventListener("click", function () {
    fileInput.click();
  });

  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  });

  dropzone.addEventListener("dragleave", function () {
    dropzone.classList.remove("drag-over");
  });

  dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    if (e.dataTransfer && e.dataTransfer.files) {
      addFiles(e.dataTransfer.files);
    }
  });

  fileInput.addEventListener("change", function () {
    addFiles(fileInput.files);
    fileInput.value = "";
  });

  mergeBtn.addEventListener("click", mergePdfs);
  downloadBtn.addEventListener("click", downloadMerged);
  resetBtn.addEventListener("click", resetAll);

  // initial state
  updateStepVisibility();
  updateMergeButtonState();
})();
