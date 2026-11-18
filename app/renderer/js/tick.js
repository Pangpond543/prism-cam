// Frame clock. Timers inside a worker are not throttled when the window is hidden or minimised,
// so the virtual camera keeps receiving frames while Prism Cam sits in the background.
let timer = 0;
onmessage = (e) => {
  clearInterval(timer);
  timer = setInterval(() => postMessage(0), 1000 / (e.data || 30));
};
