const fallbackScreens = {
    phone: { width: 1080, height: 2400 },
    tablet: { width: 1600, height: 2560 },
};

function normalizedFamily(family) {
    return family === "tablet" ? "tablet" : "phone";
}

/**
 * `screencap` and `screenrecord` already return the rotated framebuffer, so the
 * reported metrics are the display metrics — no extra transform is needed.
 */
export function displayScreenMetrics(metrics, family = "phone") {
    const fallback = fallbackScreens[normalizedFamily(family)] ?? fallbackScreens.phone;
    const width = Number(metrics?.width) > 0 ? Number(metrics.width) : fallback.width;
    const height = Number(metrics?.height) > 0 ? Number(metrics.height) : fallback.height;
    return { width, height };
}

function frameMetrics(metrics, family = "phone") {
    const nextFamily = normalizedFamily(family);
    const { width, height } = displayScreenMetrics(metrics, nextFamily);
    const shortSide = Math.min(width, height);
    const longSide = Math.max(width, height);
    const bezel = Math.round(shortSide * (nextFamily === "tablet" ? 0.03 : 0.036));
    // Android hardware corners are noticeably squarer than the iOS reference.
    const screenRadius = Math.round(shortSide * (nextFamily === "tablet" ? 0.028 : 0.075));
    const frameRadius = screenRadius + bezel;
    const frameWidth = width + bezel * 2;
    const frameHeight = height + bezel * 2;
    return {
        family: nextFamily,
        orientation: height >= width ? "portrait" : "landscape",
        bezel,
        screenRadius,
        frameRadius,
        frameWidth,
        frameHeight,
        aspect: frameWidth / frameHeight,
        sideButton: {
            width: Math.max(2, Math.round(shortSide * 0.006)),
            powerLength: Math.round(shortSide * 0.1),
            volumeLength: Math.round(shortSide * 0.17),
            powerOffset: Math.round(longSide * 0.17),
            volumeOffset: Math.round(longSide * 0.28),
        },
    };
}

export function applyDeviceMetrics({ viewport, phoneFrame }, metrics, family = "phone") {
    const next = frameMetrics(metrics, family);
    phoneFrame.dataset.frameWidth = String(next.frameWidth);
    phoneFrame.dataset.frameHeight = String(next.frameHeight);
    phoneFrame.dataset.frameAspect = String(next.aspect);
    phoneFrame.dataset.sourceBezel = String(next.bezel);
    phoneFrame.dataset.sourceScreenRadius = String(next.screenRadius);
    phoneFrame.dataset.sourceFrameRadius = String(next.frameRadius);
    phoneFrame.dataset.sourceSideButtonWidth = String(next.sideButton.width);
    phoneFrame.dataset.sourceSideButtonPowerLength = String(next.sideButton.powerLength);
    phoneFrame.dataset.sourceSideButtonVolumeLength = String(next.sideButton.volumeLength);
    phoneFrame.dataset.sourceSideButtonPowerOffset = String(next.sideButton.powerOffset);
    phoneFrame.dataset.sourceSideButtonVolumeOffset = String(next.sideButton.volumeOffset);
    phoneFrame.style.setProperty("--device-frame-width", `${next.frameWidth}px`);
    phoneFrame.style.setProperty("--device-frame-height", `${next.frameHeight}px`);
    phoneFrame.style.setProperty("--device-aspect", String(next.aspect));
    phoneFrame.classList.toggle("tablet", next.family === "tablet");
    phoneFrame.classList.toggle("phone", next.family !== "tablet");
    phoneFrame.classList.toggle("landscape", next.orientation === "landscape");
    phoneFrame.classList.toggle("portrait", next.orientation !== "landscape");
    const stage = phoneFrame.closest(".device-stage");
    stage?.classList.toggle("landscape", next.orientation === "landscape");
    stage?.classList.toggle("portrait", next.orientation !== "landscape");
    fitDeviceFrame({ viewport, phoneFrame });
}

export function fitDeviceFrame({ viewport, phoneFrame }) {
    const frameWidth = Number(phoneFrame.dataset.frameWidth);
    const frameHeight = Number(phoneFrame.dataset.frameHeight);
    const aspect = Number(phoneFrame.dataset.frameAspect);
    if (!(frameWidth > 0 && frameHeight > 0 && aspect > 0)) {
        return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const styles = getComputedStyle(viewport);
    const floatingToolbar = viewport.querySelector(".floating-toolbar");
    const toolbarGap = parseFloat(styles.getPropertyValue("--floating-toolbar-gap")) || 0;
    const toolbarVisible = floatingToolbar && getComputedStyle(floatingToolbar).display !== "none";
    const toolbarRect = toolbarVisible ? floatingToolbar.getBoundingClientRect() : { width: 0, height: 0 };
    const stage = phoneFrame.closest(".device-stage");
    const isLandscape = phoneFrame.classList.contains("landscape");
    stage?.style.setProperty("--floating-toolbar-width", `${toolbarRect.width}px`);
    stage?.style.setProperty("--floating-toolbar-height", `${toolbarRect.height}px`);
    const toolbarWidth = toolbarVisible && !isLandscape ? toolbarRect.width + toolbarGap : 0;
    const toolbarHeight = toolbarVisible && isLandscape ? toolbarRect.height + toolbarGap : 0;
    const availableWidth = viewportRect.width - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    const availableHeight = viewportRect.height - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
    const frameAvailableWidth = availableWidth - toolbarWidth;
    const frameAvailableHeight = availableHeight - toolbarHeight;
    if (frameAvailableWidth < 80 || frameAvailableHeight < 120) {
        return;
    }

    let fittedWidth = Math.min(frameWidth, frameAvailableWidth, frameAvailableHeight * aspect);
    let fittedHeight = fittedWidth / aspect;
    if (fittedHeight > frameAvailableHeight) {
        fittedHeight = Math.min(frameHeight, frameAvailableHeight);
        fittedWidth = fittedHeight * aspect;
    }
    phoneFrame.style.width = `${fittedWidth}px`;
    phoneFrame.style.height = `${fittedHeight}px`;

    const scale = fittedWidth / frameWidth;
    setScaledProperty(phoneFrame, "--bezel", phoneFrame.dataset.sourceBezel, scale);
    setScaledProperty(phoneFrame, "--screen-radius", phoneFrame.dataset.sourceScreenRadius, scale);
    setScaledProperty(phoneFrame, "--frame-radius", phoneFrame.dataset.sourceFrameRadius, scale);
    setScaledProperty(phoneFrame, "--side-button-width", phoneFrame.dataset.sourceSideButtonWidth, scale);
    setScaledProperty(phoneFrame, "--side-button-power", phoneFrame.dataset.sourceSideButtonPowerLength, scale);
    setScaledProperty(phoneFrame, "--side-button-volume", phoneFrame.dataset.sourceSideButtonVolumeLength, scale);
    setScaledProperty(phoneFrame, "--side-button-power-top", phoneFrame.dataset.sourceSideButtonPowerOffset, scale);
    setScaledProperty(phoneFrame, "--side-button-volume-top", phoneFrame.dataset.sourceSideButtonVolumeOffset, scale);
}

function setScaledProperty(element, property, sourceValue, scale) {
    const value = Number(sourceValue);
    if (value > 0 && scale > 0) {
        element.style.setProperty(property, `${Math.max(1, value * scale)}px`);
    }
}
