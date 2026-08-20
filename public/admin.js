let token = sessionStorage.getItem("jdPrestigeAdminToken") || "";
let currentOwner = null;
let bookings = [];

const loginPanel = document.getElementById("loginPanel");
const dashboard = document.getElementById("dashboard");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const dashboardMessage = document.getElementById("dashboardMessage");
const bookingList = document.getElementById("bookingList");
const barberFilter = document.getElementById("barberFilter");
const statusFilter = document.getElementById("statusFilter");
const paymentFilter = document.getElementById("paymentFilter");
const signedInAs = document.getElementById("signedInAs");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(cents || 0) / 100);
}

function formatDate(value) {
  const [year, month, day] = value.split("-");
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

async function api(url, options = {}) {
  options.headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`
  };

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function setDashboardMessage(text, type = "") {
  dashboardMessage.textContent = text;
  dashboardMessage.className = `message ${type}`.trim();
}

function renderBookings() {
  const barber = barberFilter.value;
  const status = statusFilter.value;
  const payment = paymentFilter.value;

  const visible = bookings.filter(item => {
    const barberMatch = barber === "all" || item.barber === barber;
    const statusMatch = status === "all" || item.status === status;
    const paymentMatch = payment === "all" || item.paymentStatus === payment;
    return barberMatch && statusMatch && paymentMatch;
  });

  document.getElementById("totalCount").textContent = visible.length;
  document.getElementById("pendingCount").textContent =
    visible.filter(item => item.status === "Pending").length;
  document.getElementById("paidCount").textContent =
    visible.filter(item => item.paymentStatus === "Paid").length;
  document.getElementById("dueTotal").textContent =
    formatMoney(visible.reduce((sum, item) => sum + Number(item.amountDueCents || 0), 0));

  if (!visible.length) {
    bookingList.innerHTML = '<div class="empty">No appointments match these filters.</div>';
    return;
  }

  bookingList.innerHTML = visible.map(item => `
    <article class="admin-booking">
      <div class="booking-info">
        <div class="booking-heading">
          <h3>${escapeHtml(item.name)}</h3>
          <span class="barber-badge">${escapeHtml(item.barber)}</span>
          <span class="status status-${escapeHtml(item.status.toLowerCase().replaceAll(" ", "-"))}">
            ${escapeHtml(item.status)}
          </span>
        </div>

        <p><strong>${escapeHtml(item.service)}</strong> · ${formatDate(item.date)} at ${escapeHtml(item.time)}</p>
        <p>Phone: <a href="tel:${escapeHtml(item.phone)}">${escapeHtml(item.phone)}</a></p>
        ${item.notes ? `<p>Notes: ${escapeHtml(item.notes)}</p>` : ""}

        <div class="payment-ledger">
          <div>
            <span>Service total</span>
            <strong>${formatMoney(item.priceCents)}</strong>
          </div>
          <div>
            <span>Paid</span>
            <strong>${formatMoney(item.amountPaidCents)}</strong>
          </div>
          <div>
            <span>Due</span>
            <strong>${formatMoney(item.amountDueCents)}</strong>
          </div>
          <div>
            <span>Payment</span>
            <strong>${escapeHtml(item.paymentStatus)}</strong>
          </div>
        </div>
      </div>

      <div class="booking-actions">
        <label>
          Appointment Status
          <select class="status-select" data-id="${item.id}">
            ${["Awaiting Payment","Pending","Confirmed","Completed","Canceled"].map(status =>
              `<option value="${status}" ${status === item.status ? "selected" : ""}>${status}</option>`
            ).join("")}
          </select>
        </label>

        ${Number(item.amountDueCents || 0) > 0 && Number(item.amountPaidCents || 0) > 0
          ? `<button class="balance-btn" data-balance-id="${item.id}" type="button">
               Create Balance Payment Link
             </button>`
          : ""}

        <button class="delete-btn" data-delete-id="${item.id}" type="button">Delete</button>
      </div>
    </article>
  `).join("");

  document.querySelectorAll(".status-select").forEach(select => {
    select.addEventListener("change", async () => {
      try {
        await api(`/api/admin/bookings/${select.dataset.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: select.value })
        });
        setDashboardMessage("Appointment status updated.", "success");
        await loadBookings();
      } catch (error) {
        setDashboardMessage(error.message, "error");
        await loadBookings();
      }
    });
  });

  document.querySelectorAll("[data-balance-id]").forEach(button => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Creating link...";

      try {
        const data = await api(`/api/admin/bookings/${button.dataset.balanceId}/payment-link`, {
          method: "POST"
        });

        const copied = await copyText(data.checkoutUrl);
        if (copied) {
          setDashboardMessage(
            `Balance payment link copied (${formatMoney(data.amountDueCents)} due).`,
            "success"
          );
        } else {
          window.prompt("Copy this balance payment link:", data.checkoutUrl);
        }
      } catch (error) {
        setDashboardMessage(error.message, "error");
      } finally {
        button.disabled = false;
        button.textContent = "Create Balance Payment Link";
      }
    });
  });

  document.querySelectorAll("[data-delete-id]").forEach(button => {
    button.addEventListener("click", async () => {
      if (!confirm("Delete this appointment permanently?")) return;

      try {
        await api(`/api/admin/bookings/${button.dataset.deleteId}`, {
          method: "DELETE"
        });
        setDashboardMessage("Appointment deleted.", "success");
        await loadBookings();
      } catch (error) {
        setDashboardMessage(error.message, "error");
      }
    });
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function loadBookings() {
  try {
    bookings = await api("/api/admin/bookings");
    bookings.sort((a, b) =>
      `${a.date} ${a.time} ${a.barber}`.localeCompare(`${b.date} ${b.time} ${b.barber}`)
    );
    renderBookings();
  } catch {
    logout();
  }
}

async function showDashboard(ownerFromLogin = null) {
  try {
    currentOwner = ownerFromLogin || await api("/api/admin/me");
    loginPanel.classList.add("hidden");
    dashboard.classList.remove("hidden");

    signedInAs.textContent = `Signed in as ${currentOwner.ownerName}.`;
    barberFilter.value = currentOwner.ownerName;

    await loadBookings();
  } catch {
    logout();
  }
}

function logout() {
  token = "";
  currentOwner = null;
  bookings = [];
  sessionStorage.removeItem("jdPrestigeAdminToken");
  dashboard.classList.add("hidden");
  loginPanel.classList.remove("hidden");
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  loginMessage.textContent = "Signing in...";

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Login failed.");

    token = data.token;
    sessionStorage.setItem("jdPrestigeAdminToken", token);
    loginMessage.textContent = "";

    await showDashboard({
      username: data.username,
      ownerName: data.ownerName
    });
  } catch (error) {
    loginMessage.textContent = error.message;
    loginMessage.className = "message error";
  }
});

barberFilter.addEventListener("change", renderBookings);
statusFilter.addEventListener("change", renderBookings);
paymentFilter.addEventListener("change", renderBookings);
document.getElementById("refreshBtn").addEventListener("click", loadBookings);
document.getElementById("logoutBtn").addEventListener("click", logout);

if (token) showDashboard();
