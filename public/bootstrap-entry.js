if (window.location.pathname.startsWith("/app/")) {
  import("./native/app.js");
} else {
  import("./app.js");
}
