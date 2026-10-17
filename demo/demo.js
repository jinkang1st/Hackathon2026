const price = document.getElementById("price");
document.querySelectorAll("[data-price]").forEach(button => {
  button.addEventListener("click", () => {
    price.textContent = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(Number(button.dataset.price));
  });
});
document.getElementById("spa").addEventListener("click", () => {
  history.pushState({}, "", `?product=studio-one&visit=${Date.now()}`);
  price.textContent = "£1,299";
});
document.getElementById("add").addEventListener("click", () => {
  document.getElementById("bag-message").textContent = "Demo only. Nothing was purchased or added to a real bag.";
});
