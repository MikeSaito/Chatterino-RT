/** EditableModelView-like table (Add / Remove / Move up / down). */

export type TableColumn = {
  key: string;
  label: string;
  type: "text" | "checkbox" | "color" | "select";
  options?: { label: string; value: string }[];
};

export type TableModel = {
  columns: TableColumn[];
  blankRow: Record<string, string | boolean>;
  rows: Record<string, string | boolean>[];
};

export function mountEditableTable(
  host: HTMLElement,
  model: TableModel,
  onChange: () => void,
): {
  getRows: () => Record<string, string | boolean>[];
  setRows: (rows: Record<string, string | boolean>[]) => void;
  setRowFilter: (fn: ((row: Record<string, string | boolean>, index: number) => boolean) | null) => void;
} {
  host.classList.add("editable-table-host");
  host.replaceChildren();

  const table = document.createElement("table");
  table.className = "editable-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of model.columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);

  const toolbar = document.createElement("div");
  toolbar.className = "editable-table-toolbar";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "Add";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  const upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.textContent = "Move up";
  const downBtn = document.createElement("button");
  downBtn.type = "button";
  downBtn.textContent = "Move down";
  toolbar.append(addBtn, removeBtn, upBtn, downBtn);

  host.append(toolbar, table);

  let selected = -1;
  let rowFilter: ((row: Record<string, string | boolean>, index: number) => boolean) | null =
    null;

  const syncToolbar = (): void => {
    const filtered = Boolean(rowFilter);
    addBtn.disabled = filtered;
    removeBtn.disabled = filtered;
    upBtn.disabled = filtered || selected <= 0;
    downBtn.disabled = filtered || selected < 0 || selected >= model.rows.length - 1;
  };

  const paint = (): void => {
    tbody.replaceChildren();
    const visibleRows = model.rows.filter((row, index) =>
      rowFilter ? rowFilter(row, index) : true,
    );
    if (visibleRows.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "editable-table-empty";
      const td = document.createElement("td");
      td.colSpan = model.columns.length;
      const filtered = Boolean(rowFilter);
      if (filtered) {
        td.textContent = "Нет совпадений.";
      } else {
        td.textContent = "Пусто. Добавьте строку кнопкой Add.";
      }
      tr.append(td);
      tbody.append(tr);
      syncToolbar();
      return;
    }
    model.rows.forEach((row, index) => {
      if (rowFilter && !rowFilter(row, index)) {
        return;
      }
      const tr = document.createElement("tr");
      if (index === selected) {
        tr.classList.add("is-selected");
      }
      tr.addEventListener("click", () => {
        selected = index;
        paint();
      });
      for (const col of model.columns) {
        const td = document.createElement("td");
        const value = row[col.key];
        if (col.type === "checkbox") {
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = Boolean(value);
          input.addEventListener("click", (ev) => {
            ev.stopPropagation();
          });
          input.addEventListener("change", () => {
            row[col.key] = input.checked;
            onChange();
          });
          td.append(input);
        } else if (col.type === "color") {
          const input = document.createElement("input");
          input.type = "color";
          const raw = typeof value === "string" && /^#[0-9a-fA-F]{6}/.test(value)
            ? value.slice(0, 7)
            : "#7f3f49";
          input.value = raw;
          input.addEventListener("click", (ev) => {
            ev.stopPropagation();
          });
          input.addEventListener("change", () => {
            row[col.key] = input.value;
            onChange();
          });
          td.append(input);
        } else if (col.type === "select") {
          const select = document.createElement("select");
          for (const opt of col.options ?? []) {
            const option = document.createElement("option");
            option.value = opt.value;
            option.textContent = opt.label;
            select.append(option);
          }
          select.value =
            typeof value === "string" && (col.options ?? []).some((o) => o.value === value)
              ? value
              : (col.options?.[0]?.value ?? "");
          row[col.key] = select.value;
          select.addEventListener("click", (ev) => {
            ev.stopPropagation();
          });
          select.addEventListener("change", () => {
            row[col.key] = select.value;
            onChange();
          });
          td.append(select);
        } else {
          const input = document.createElement("input");
          input.type = "text";
          input.value = typeof value === "string" ? value : String(value ?? "");
          input.addEventListener("click", (ev) => {
            ev.stopPropagation();
          });
          input.addEventListener("input", () => {
            row[col.key] = input.value;
            onChange();
          });
          td.append(input);
        }
        tr.append(td);
      }
      tbody.append(tr);
    });
    syncToolbar();
  };

  addBtn.addEventListener("click", () => {
    model.rows.push({ ...model.blankRow });
    selected = model.rows.length - 1;
    paint();
    onChange();
  });

  removeBtn.addEventListener("click", () => {
    if (selected < 0 || selected >= model.rows.length) {
      return;
    }
    model.rows.splice(selected, 1);
    selected = Math.min(selected, model.rows.length - 1);
    paint();
    onChange();
  });

  upBtn.addEventListener("click", () => {
    if (selected <= 0) {
      return;
    }
    const tmp = model.rows[selected - 1];
    model.rows[selected - 1] = model.rows[selected];
    model.rows[selected] = tmp;
    selected -= 1;
    paint();
    onChange();
  });

  downBtn.addEventListener("click", () => {
    if (selected < 0 || selected >= model.rows.length - 1) {
      return;
    }
    const tmp = model.rows[selected + 1];
    model.rows[selected + 1] = model.rows[selected];
    model.rows[selected] = tmp;
    selected += 1;
    paint();
    onChange();
  });

  paint();

  return {
    getRows: () => model.rows.map((row) => ({ ...row })),
    setRows: (rows) => {
      model.rows = rows.map((row) => ({ ...model.blankRow, ...row }));
      selected = -1;
      paint();
    },
    setRowFilter: (fn) => {
      rowFilter = fn;
      selected = -1;
      paint();
    },
  };
}
