import { renderIcon } from "./icons.js";

/** Reads "2 waiting" off the queue, or nothing when nobody is queued. */
function waitingSuffix(queue) {
    const waiting = queue?.waiting ?? 0;
    return waiting > 0 ? ` · ${waiting} waiting` : "";
}

/** Describes how a device is currently being used, if at all. */
function usageBadge(device) {
    const queue = device.queue ?? null;

    // We are in line for this device: the most useful thing we can say.
    if (queue?.myPosition) {
        return {
            kind: "waiting",
            label: `Waiting · #${queue.myPosition}`,
            title: `You are number ${queue.myPosition} in line for this device${
                queue.holder ? `, behind ${queue.holder.sessionLabel}` : ""
            }`,
        };
    }

    // The queue holder is authoritative: it is what actually blocks other sessions.
    if (queue?.holder && !queue.holder.isMine) {
        return {
            kind: "foreign",
            label: `In use · ${queue.holder.sessionLabel}${waitingSuffix(queue)}`,
            title:
                `${queue.holder.sessionLabel} is using this device` +
                `${queue.holder.reason ? `: ${queue.holder.reason}` : ""}.` +
                ` Agents can queue for it instead of interrupting.`,
        };
    }

    // Another Copilot session takes priority: it is the case you cannot see from here.
    if (device.foreignUse) {
        const other = device.foreignUse;
        const controlling = other.mode === "control";
        return {
            kind: "foreign",
            label: controlling ? `In use · ${other.sessionLabel}` : `Open · ${other.sessionLabel}`,
            title: controlling
                ? `Another Copilot session (${other.sessionLabel}) is driving this device${other.reason ? `: ${other.reason}` : ""}`
                : `Another Copilot session (${other.sessionLabel}) has this device open`,
        };
    }
    // Capture we cannot attribute to a session: another tool is using the device.
    if (device.foreignCapture) {
        return {
            kind: "foreign",
            label: "In use elsewhere",
            title: "Something outside Copilot is capturing this device — Android Studio, scrcpy, or an adb command",
        };
    }
    if (device.leaseActive) {
        return {
            kind: "agent",
            label: `Agent control${waitingSuffix(queue)}`,
            title: device.leaseReason ? `An agent is driving this device: ${device.leaseReason}` : "An agent is driving this device",
        };
    }
    if (device.isCurrent) {
        return { kind: "current", label: "This canvas", title: "Shown in this canvas" };
    }
    if (device.isOpen) {
        const count = device.openCount ?? 1;
        return {
            kind: "open",
            label: count > 1 ? `Open ×${count}` : "Open",
            title: "Already open in another canvas",
        };
    }
    return null;
}

export function createDevicePicker({
    elements,
    fetchJson,
    getState,
    isPending,
    loadState,
    reconnectStream,
    setNotice,
    withPending,
}) {
    let open = false;
    let data = null;

    function close() {
        open = false;
        elements.button.setAttribute("aria-expanded", "false");
        elements.menu.classList.add("hidden");
    }

    function position() {
        if (!open) {
            return;
        }
        const rect = elements.button.getBoundingClientRect();
        const width = Math.min(460, Math.max(340, window.innerWidth - 24));
        const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
        elements.menu.style.width = `${width}px`;
        elements.menu.style.left = `${left}px`;
        elements.menu.style.top = `${rect.bottom + 8}px`;
    }

    async function refresh() {
        data = await fetchJson("api/devices");
        render();
    }

    function show() {
        open = true;
        elements.button.setAttribute("aria-expanded", "true");
        elements.menu.classList.remove("hidden");
        position();
        void refresh().catch((error) => setNotice(error.message, true));
    }

    function toggle() {
        if (open) {
            close();
        } else {
            show();
        }
    }

    function appendRow(container, device, disabled) {
        const unavailable = device.isAvailable === false;
        const row = document.createElement("div");
        row.className = "device-row";
        row.dataset.current = String(device.isCurrent);
        row.dataset.open = String(device.isOpen);
        row.dataset.deviceId = device.deviceId;
        row.dataset.disabled = String(disabled || device.isCurrent || unavailable);
        row.role = "button";
        row.tabIndex = disabled || device.isCurrent || unavailable ? -1 : 0;

        const details = document.createElement("div");
        details.className = "device-row-details";
        const nameLine = document.createElement("div");
        nameLine.className = "device-row-name";
        const kindIcon = document.createElement("span");
        kindIcon.className = "device-row-kind";
        kindIcon.innerHTML = renderIcon(device.kind === "device" ? "usb" : "phone");
        kindIcon.title = device.kind === "device" ? "Connected device" : "Emulator";
        const name = document.createElement("span");
        name.textContent = device.name ?? device.deviceId;
        nameLine.append(kindIcon, name);

        // Say when a device is already in use, so switching to it is an informed choice.
        const badge = usageBadge(device);
        if (badge) {
            const tag = document.createElement("span");
            tag.className = "device-row-badge";
            tag.dataset.kind = badge.kind;
            tag.textContent = badge.label;
            tag.title = badge.title;
            nameLine.append(tag);
        }
        const meta = document.createElement("div");
        meta.className = "device-row-meta";
        meta.textContent = [device.versionLabel, device.kind === "device" ? device.serial : device.deviceId]
            .filter(Boolean)
            .join(" · ");
        details.append(nameLine, meta);

        const actions = document.createElement("div");
        actions.className = "device-row-actions";
        const openButton = document.createElement("button");
        openButton.className = "device-action";
        openButton.type = "button";
        openButton.dataset.deviceAction = "open";
        openButton.dataset.deviceId = device.deviceId;
        openButton.innerHTML = renderIcon("newTab");
        openButton.title = device.isCurrent ? "Already shown in this tab" : "Open this device in a new tab";
        openButton.setAttribute("aria-label", `Open ${device.name} in a new tab`);
        openButton.disabled = disabled || device.isCurrent || unavailable;
        actions.append(openButton);
        row.append(details, actions);
        container.append(row);
    }

    function render() {
        const state = getState();
        const disabled = isPending();
        elements.button.disabled = disabled;
        if (!data) {
            elements.content.replaceChildren();
            const loading = document.createElement("div");
            loading.className = "device-empty";
            loading.textContent = "Loading devices…";
            elements.content.append(loading);
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const [key, label, emptyCopy] of [
            ["booted", "Running", "Nothing is running."],
            ["available", "Available", "No AVDs are available."],
            ["unavailable", "Unavailable", ""],
        ]) {
            const devices = data.groups?.[key] ?? [];
            if (key === "unavailable" && devices.length === 0) {
                continue;
            }
            const section = document.createElement("section");
            section.className = "device-group";
            const heading = document.createElement("div");
            heading.className = "device-group-heading";
            heading.textContent = `${label} (${devices.length})`;
            section.append(heading);
            if (devices.length === 0) {
                const empty = document.createElement("div");
                empty.className = "device-empty";
                empty.textContent = emptyCopy;
                section.append(empty);
            } else {
                for (const device of devices) {
                    appendRow(section, device, disabled);
                }
            }
            fragment.append(section);
        }
        elements.content.replaceChildren(fragment);
        elements.button.dataset.deviceState = String(state?.state ?? "unknown").toLowerCase();
        position();
    }

    function bind() {
        elements.button.addEventListener("click", (event) => {
            event.preventDefault();
            toggle();
        });
        elements.content.addEventListener("click", (event) => {
            const button = event.target.closest("[data-device-action]");
            if (button?.disabled) {
                return;
            }
            const row = event.target.closest(".device-row");
            if (!button && (!row || row.dataset.disabled === "true")) {
                return;
            }
            const state = getState();
            const deviceId = button?.dataset.deviceId ?? row.dataset.deviceId;
            const action =
                button?.dataset.deviceAction ??
                (state?.state === "Unassigned" || row.dataset.open !== "true" ? "switch" : "focus");
            close();
            void withPending(async () => {
                if (action === "switch") {
                    await fetchJson("api/device/switch", { deviceId });
                    await loadState();
                    await refresh();
                    reconnectStream();
                    return;
                }
                const result = await fetchJson("api/device/open", { deviceId });
                setNotice(result.focusedExisting ? "Focused the existing device tab." : "Opened the device in a new tab.");
                await refresh();
            }).catch((error) => setNotice(error.message, true));
        });
        elements.content.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") {
                return;
            }
            if (event.target.closest("[data-device-action]")) {
                return;
            }
            const row = event.target.closest(".device-row");
            if (!row || row.dataset.disabled === "true") {
                return;
            }
            event.preventDefault();
            row.click();
        });
        document.addEventListener("click", (event) => {
            if (open && !elements.root.contains(event.target)) {
                close();
            }
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && open) {
                close();
                elements.button.focus();
                event.preventDefault();
            }
        });
        window.addEventListener("resize", position);
    }

    return { bind, close, refresh, render };
}
