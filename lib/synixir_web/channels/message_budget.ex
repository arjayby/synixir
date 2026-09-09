defmodule SynixirWeb.MessageBudget do
  @moduledoc false

  def new(limits, now) do
    %{
      tokens: Keyword.fetch!(limits, :message_burst),
      capacity: Keyword.fetch!(limits, :message_burst),
      rate: Keyword.fetch!(limits, :messages_per_second),
      updated_at: now
    }
  end

  def consume(budget, now) do
    tokens =
      min(budget.capacity, budget.tokens + max(now - budget.updated_at, 0) * budget.rate / 1000)

    budget = %{budget | tokens: tokens, updated_at: now}

    if tokens >= 1 do
      {:ok, %{budget | tokens: tokens - 1}}
    else
      {:error, :rate_limited, budget}
    end
  end
end
