const icons = {
    install: [
        ["path", { d: "M12 3v10" }],
        ["path", { d: "m8 9 4 4 4-4" }],
        ["path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" }],
    ],
    shutdown: [
        ["path", { d: "M12 2v10" }],
        ["path", { d: "M18.4 6.6a9 9 0 1 1-12.8 0" }],
    ],
    power: [
        ["path", { d: "M12 3v9" }],
        ["path", { d: "M17.7 7.3a8 8 0 1 1-11.4 0" }],
    ],
    home: [["circle", { cx: "12", cy: "12", r: "8" }]],
    back: [
        ["path", { d: "M18 6 8 12l10 6z" }],
    ],
    recents: [["rect", { x: "5", y: "5", width: "14", height: "14", rx: "2" }]],
    rotateRight: [
        ["path", { d: "M12 5H6a2 2 0 0 0-2 2v3" }],
        ["path", { d: "m9 8 3-3-3-3" }],
        ["path", { d: "M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" }],
    ],
    volumeUp: [
        ["path", { d: "M11 5 6 9H3v6h3l5 4z" }],
        ["path", { d: "M16 9a4 4 0 0 1 0 6" }],
        ["path", { d: "M19 6.5a8 8 0 0 1 0 11" }],
    ],
    volumeDown: [
        ["path", { d: "M11 5 6 9H3v6h3l5 4z" }],
        ["path", { d: "M16 9a4 4 0 0 1 0 6" }],
    ],
    newTab: [
        ["path", { d: "M15 3h6v6" }],
        ["path", { d: "M10 14 21 3" }],
        ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
    ],
    phone: [
        ["rect", { x: "7", y: "2", width: "10", height: "20", rx: "2" }],
        ["path", { d: "M11 18h2" }],
    ],
    usb: [
        ["path", { d: "M12 21V7" }],
        ["path", { d: "m8 11 4-4 4 4" }],
        ["circle", { cx: "12", cy: "22", r: "1" }],
    ],
};

export function renderIcon(name) {
    const icon = icons[name];
    if (!icon) {
        return "";
    }

    const children = icon
        .map(([tag, attrs]) => {
            const serialized = Object.entries(attrs)
                .map(([key, value]) => `${key}="${value}"`)
                .join(" ");
            return `<${tag} ${serialized}></${tag}>`;
        })
        .join("");

    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${children}</svg>`;
}
