// Only new server instances select this wrapper. Legacy static bytes remain intact.
import "./app.js";
const button = document.createElement("button");
button.textContent = "产品资料库";
button.addEventListener("click", () => location.assign("/products"));
document.querySelector("#nav").append(button);
