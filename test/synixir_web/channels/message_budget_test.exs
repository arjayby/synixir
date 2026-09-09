defmodule SynixirWeb.MessageBudgetTest do
  use ExUnit.Case, async: true
  alias SynixirWeb.MessageBudget

  test "a burst is bounded and tokens refill at the configured rate" do
    budget = MessageBudget.new([message_burst: 2, messages_per_second: 4], 0)
    assert {:ok, budget} = MessageBudget.consume(budget, 0)
    assert {:ok, budget} = MessageBudget.consume(budget, 0)
    assert {:error, :rate_limited, budget} = MessageBudget.consume(budget, 0)
    assert {:error, :rate_limited, budget} = MessageBudget.consume(budget, 249)
    assert {:ok, budget} = MessageBudget.consume(budget, 250)
    assert {:error, :rate_limited, budget} = MessageBudget.consume(budget, 250)
    assert {:ok, budget} = MessageBudget.consume(budget, 10_000)
    assert {:ok, budget} = MessageBudget.consume(budget, 10_000)
    assert {:error, :rate_limited, _budget} = MessageBudget.consume(budget, 10_000)
  end
end
