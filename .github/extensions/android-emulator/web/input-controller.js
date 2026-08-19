const supportedKeyCodes = new Set([
    "Enter",
    "Escape",
    "Backspace",
    "Tab",
    "Space",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Backquote",
    "Comma",
    "Period",
    "Slash",
    "ArrowRight",
    "ArrowLeft",
    "ArrowDown",
    "ArrowUp",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Delete",
]);

/** Printable characters go through `input text`; everything else becomes a keyevent. */
function printableCharacter(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
        return null;
    }
    return event.key.length === 1 && event.key >= " " && event.key <= "~" ? event.key : null;
}

export function createInputController({
    elements,
    apiUrl,
    fetchJson,
    getState,
    isControlUnavailable,
    setNotice,
    setState,
    withPending,
}) {
    let activePointer = null;

    function canInteract() {
        const state = getState();
        return Boolean(state && state.state === "Booted" && !isControlUnavailable());
    }

    function forwardKeyboardEvent(event) {
        if (!canInteract()) {
            return;
        }
        const target = event.target;
        if (target instanceof Element && target.closest("button, select, input, textarea, [contenteditable='true']")) {
            return;
        }

        const character = printableCharacter(event);
        if (character) {
            void fetchJson("api/input/text", { text: character }).catch((error) => setNotice(error.message, true));
            event.preventDefault();
            return;
        }
        if (!supportedKeyCodes.has(event.code)) {
            return;
        }
        void fetchJson("api/input/key", { code: event.code }).catch((error) => setNotice(error.message, true));
        event.preventDefault();
    }

    function normalizedScreenPoint(event) {
        const rect = elements.screenWindow.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return null;
        }
        return {
            x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        };
    }

    function postTouchPhase(phase, point) {
        return fetchJson("api/input/touch", {
            phase,
            x: point.x,
            y: point.y,
            coordinateSpace: "normalized",
        });
    }

    function createTouchStream() {
        if (!("WebSocket" in window)) {
            return null;
        }
        const url = apiUrl("api/input/touch-ws");
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(url);
        const queued = [];
        let opened = false;
        let closed = false;
        let failed = false;
        const eventPayload = (phase, point) => ({
            phase,
            x: point.x,
            y: point.y,
            coordinateSpace: "normalized",
        });
        // Phases must arrive in the order they happened. Posting them concurrently
        // lets "up" overtake "move", which the device sees as a tap instead of a
        // drag -- or as nothing at all. This bites exactly when the socket has not
        // finished connecting yet, i.e. the first gesture after the canvas opens.
        let ordered = Promise.resolve();
        const post = (phase, point) => {
            ordered = ordered
                .then(() => postTouchPhase(phase, point))
                .catch((error) => setNotice(error.message, true));
            return ordered;
        };
        const fallback = (events) => {
            failed = true;
            for (const event of events) {
                void post(event.phase, event);
            }
        };
        socket.addEventListener("open", () => {
            opened = true;
            for (const event of queued.splice(0)) {
                socket.send(JSON.stringify(event));
            }
            if (closed) {
                socket.close();
            }
        });
        socket.addEventListener("error", () => {
            if (!closed) {
                fallback(queued.splice(0));
            }
        });
        socket.addEventListener("close", () => {
            if (!closed && !failed) {
                fallback(queued.splice(0));
            }
        });
        return {
            send(phase, point) {
                if (closed) {
                    return;
                }
                const event = eventPayload(phase, point);
                if (failed) {
                    void post(phase, point);
                } else if (opened && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify(event));
                } else {
                    queued.push(event);
                }
            },
            close() {
                if (closed) {
                    return;
                }
                closed = true;
                if (!opened) {
                    fallback(queued.splice(0));
                }
                if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                    socket.close();
                }
            },
            abort() {
                if (closed) {
                    return;
                }
                closed = true;
                queued.length = 0;
                socket.close();
            },
        };
    }

    function dispatchTouch(phase, point, dispatcher = activePointer?.dispatcher) {
        if (dispatcher) {
            dispatcher.send(phase, point);
        } else {
            void postTouchPhase(phase, point).catch((error) => setNotice(error.message, true));
        }
    }

    function bind() {
        elements.screenWindow.addEventListener("pointerdown", (event) => {
            if (event.target.closest("button, summary, details, a, input, select")) {
                return;
            }
            if (!canInteract()) {
                return;
            }
            const point = normalizedScreenPoint(event);
            if (!point) {
                return;
            }
            elements.viewport.focus();
            elements.screenWindow.setPointerCapture(event.pointerId);
            const dispatcher = createTouchStream();
            activePointer = {
                pointerId: event.pointerId,
                lastX: point.x,
                lastY: point.y,
                pendingMove: null,
                moveScheduled: false,
                ended: false,
                dispatcher,
            };
            dispatchTouch("down", point, dispatcher);
            event.preventDefault();
        });
        elements.screenWindow.addEventListener("pointermove", (event) => {
            if (!activePointer || activePointer.pointerId !== event.pointerId) {
                return;
            }
            const point = normalizedScreenPoint(event);
            if (!point) {
                return;
            }
            activePointer.lastX = point.x;
            activePointer.lastY = point.y;
            activePointer.pendingMove = point;
            // One sample per frame is plenty: the server coalesces them into swipe segments.
            if (!activePointer.moveScheduled) {
                activePointer.moveScheduled = true;
                requestAnimationFrame(() => {
                    if (!activePointer || activePointer.ended) {
                        return;
                    }
                    activePointer.moveScheduled = false;
                    const move = activePointer.pendingMove;
                    activePointer.pendingMove = null;
                    if (move) {
                        dispatchTouch("move", move, activePointer.dispatcher);
                    }
                });
            }
            event.preventDefault();
        });
        const finishPointer = (event, cancelled = false) => {
            if (!activePointer || activePointer.pointerId !== event.pointerId) {
                return;
            }
            const pointer = activePointer;
            activePointer = null;
            pointer.ended = true;
            if (elements.screenWindow.hasPointerCapture(event.pointerId)) {
                elements.screenWindow.releasePointerCapture(event.pointerId);
            }
            if (!canInteract()) {
                pointer.dispatcher?.abort();
                return;
            }
            const point = normalizedScreenPoint(event);
            dispatchTouch(
                cancelled ? "cancel" : "up",
                { x: point?.x ?? pointer.lastX, y: point?.y ?? pointer.lastY },
                pointer.dispatcher,
            );
            pointer.dispatcher?.close();
            event.preventDefault();
        };
        elements.screenWindow.addEventListener("pointerup", (event) => finishPointer(event));
        elements.screenWindow.addEventListener("pointercancel", (event) => finishPointer(event, true));
        document.addEventListener("keydown", forwardKeyboardEvent, true);
        elements.takeBack.addEventListener("click", () => {
            void withPending(async () => {
                setState(await fetchJson("api/control/revoke", {}));
                setNotice("Control returned to you.");
            }).catch((error) => setNotice(error.message, true));
        });
    }

    return { bind };
}
