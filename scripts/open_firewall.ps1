<#
    Opens the Mori dashboard (TCP 3000) for the local network, so a phone on
    the same Wi-Fi can reach http://<pc-ip>:3000.

    Run in an elevated PowerShell (right click -> "Run as administrator"):

        powershell -ExecutionPolicy Bypass -File scripts\open_firewall.ps1

    Remove the rule again with:

        powershell -ExecutionPolicy Bypass -File scripts\open_firewall.ps1 -Remove
#>
param(
    [int]$Port = 3000,
    [string]$Name = "Mori Dashboard",
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
    Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Host "Firewall rule '$Name' removed."
    exit 0
}

$existing = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Firewall rule '$Name' already exists - updating it."
    Remove-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
}

# Private profile only: the dashboard is plain HTTP, so it must not be
# reachable from a public network.
New-NetFirewallRule -DisplayName $Name `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Private `
    -Description "Mori dashboard (HTTP, local network only)" | Out-Null

Write-Host "Firewall rule '$Name' created for TCP $Port (Private profile)."
Write-Host "Open the dashboard on your phone at:  http://<this-pc-ip>:$Port"
