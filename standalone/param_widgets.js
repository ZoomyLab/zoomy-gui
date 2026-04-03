function renderParamWidgets(schema, onChange) {
    var container = document.createElement("div");
    container.className = "param-widgets";
    var params = schema.params;

    Object.keys(params).forEach(function (name) {
        var p = params[name];
        var widget = null;

        if (p.type === "Integer" && p.bounds) {
            widget = createSlider(name, p, true, onChange);
        } else if (p.type === "Number" && p.bounds) {
            widget = createSlider(name, p, false, onChange);
        } else if (p.type === "Boolean") {
            widget = createCheckbox(name, p, onChange);
        } else if (p.type === "Selector" || p.type === "ObjectSelector") {
            widget = createSelect(name, p, onChange);
        } else if (p.type === "String") {
            widget = createTextInput(name, p, onChange);
        } else if (p.type === "Dict" && p.default) {
            widget = createDictWidgets(name, p, onChange);
        } else if (p.default !== null && p.default !== undefined && !p.callable) {
            widget = createGenericInput(name, p, onChange);
        }

        if (widget) container.appendChild(widget);
    });

    return container;
}

function createWidgetRow(label, input, doc) {
    var row = document.createElement("div");
    row.className = "param-row";
    var lbl = document.createElement("label");
    lbl.className = "param-label";
    lbl.textContent = label;
    if (doc) lbl.title = doc;
    row.appendChild(lbl);
    row.appendChild(input);
    return row;
}

function createSlider(name, p, isInt, onChange) {
    var wrap = document.createElement("div");
    wrap.className = "param-slider-wrap";
    var input = document.createElement("input");
    input.type = "range";
    input.min = p.bounds[0];
    input.max = p.bounds[1];
    input.value = p.default !== null ? p.default : p.bounds[0];
    input.step = isInt ? (p.step || 1) : (p.step || (p.bounds[1] - p.bounds[0]) / 100);
    var valSpan = document.createElement("span");
    valSpan.className = "param-value";
    valSpan.textContent = input.value;
    input.oninput = function () {
        valSpan.textContent = input.value;
        if (onChange) onChange(name, isInt ? parseInt(input.value) : parseFloat(input.value));
    };
    wrap.appendChild(input);
    wrap.appendChild(valSpan);
    return createWidgetRow(name, wrap, p.doc);
}

function createCheckbox(name, p, onChange) {
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!p.default;
    input.onchange = function () {
        if (onChange) onChange(name, input.checked);
    };
    return createWidgetRow(name, input, p.doc);
}

function createSelect(name, p, onChange) {
    var select = document.createElement("select");
    (p.objects || []).forEach(function (opt) {
        var option = document.createElement("option");
        option.value = opt;
        option.textContent = opt;
        if (opt === p.default) option.selected = true;
        select.appendChild(option);
    });
    select.onchange = function () {
        if (onChange) onChange(name, select.value);
    };
    return createWidgetRow(name, select, p.doc);
}

function createTextInput(name, p, onChange) {
    var input = document.createElement("input");
    input.type = "text";
    input.value = p.default || "";
    input.onchange = function () {
        if (onChange) onChange(name, input.value);
    };
    return createWidgetRow(name, input, p.doc);
}

function createGenericInput(name, p, onChange) {
    var input = document.createElement("input");
    input.type = typeof p.default === "number" ? "number" : "text";
    input.value = p.default;
    if (typeof p.default === "number") input.step = "any";
    input.onchange = function () {
        var val = typeof p.default === "number" ? parseFloat(input.value) : input.value;
        if (onChange) onChange(name, val);
    };
    return createWidgetRow(name, input, p.doc);
}

function createDictWidgets(name, p, onChange) {
    var fieldset = document.createElement("fieldset");
    fieldset.className = "param-dict";
    var legend = document.createElement("legend");
    legend.textContent = name;
    fieldset.appendChild(legend);

    Object.keys(p.default).forEach(function (key) {
        var val = p.default[key];
        var input = document.createElement("input");
        input.type = "number";
        input.step = "any";
        input.value = val;
        input.onchange = function () {
            if (onChange) onChange(name + "." + key, parseFloat(input.value));
        };
        fieldset.appendChild(createWidgetRow(key, input, ""));
    });

    return fieldset;
}
